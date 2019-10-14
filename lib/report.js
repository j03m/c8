const Exclude = require('test-exclude')
const furi = require('furi')
const libCoverage = require('istanbul-lib-coverage')
const libReport = require('istanbul-lib-report')
const reports = require('istanbul-reports')
const { readdirSync, readFileSync } = require('fs')
const { isAbsolute, resolve } = require('path')
// TODO: switch back to @c88/v8-coverage once patch is landed.
const { mergeProcessCovs } = require('@bcoe/v8-coverage')
const v8toIstanbul = require('v8-to-istanbul')
const isCjsEsmBridgeCov = require('./is-cjs-esm-bridge')

class Report {
  constructor ({
    exclude,
    include,
    reporter,
    reportsDirectory,
    tempDirectory,
    watermarks,
    omitRelative,
    wrapperLength,
    resolve: resolvePaths,
    all
  }) {
    this.reporter = reporter
    this.reportsDirectory = reportsDirectory
    this.tempDirectory = tempDirectory
    this.watermarks = watermarks
    this.resolve = resolvePaths || process.cwd()
    this.exclude = Exclude({
      exclude: exclude,
      include: include
    })
    this.omitRelative = omitRelative
    this.sourceMapCache = {}
    this.wrapperLength = wrapperLength
    this.all = all
  }

  async run () {
    const map = await this.getCoverageMapFromAllCoverageFiles()
    var context = libReport.createContext({
      dir: this.reportsDirectory,
      watermarks: this.watermarks
    })

    const tree = libReport.summarizers.pkg(map)

    this.reporter.forEach(function (_reporter) {
      tree.visit(reports.create(_reporter), context)
    })
  }

  async getCoverageMapFromAllCoverageFiles () {
    // the merge process can be very expensive, and it's often the case that
    // check-coverage is called immediately after a report. We memoize the
    // result from getCoverageMapFromAllCoverageFiles() to address this
    // use-case.
    if (this._allCoverageFiles) return this._allCoverageFiles

    const allFilesMap = this.all ? this.getFileListForAll() : null
    const map = libCoverage.createCoverageMap()
    const v8ProcessCov = this._getMergedProcessCov()
    const resultCountPerPath = new Map()
    const possibleCjsEsmBridges = new Map()

    for (const v8ScriptCov of v8ProcessCov.result) {
      try {
        const sources = this._getSourceMap(v8ScriptCov)
        const path = resolve(this.resolve, v8ScriptCov.url)
        const converter = v8toIstanbul(path, this.wrapperLength, sources)

        // if this file was read initially by --all indicate that
        // we have a coverage record for it and therefore it must
        // have been loaded
        if (this.all && allFilesMap.has(path)){
          allFilesMap.set(path, true);
        }

        await converter.load()

        if (resultCountPerPath.has(path)) {
          resultCountPerPath.set(path, resultCountPerPath.get(path) + 1)
        } else {
          resultCountPerPath.set(path, 0)
        }

        if (isCjsEsmBridgeCov(v8ScriptCov)) {
          possibleCjsEsmBridges.set(converter, {
            path,
            functions: v8ScriptCov.functions
          })
        } else {
          converter.applyCoverage(v8ScriptCov.functions)
          map.merge(converter.toIstanbul())
        }
      } catch (err) {
        console.warn(`file: ${v8ScriptCov.url} error: ${err.stack}`)
      }
    }

    for (const [converter, { path, functions }] of possibleCjsEsmBridges) {
      if (resultCountPerPath.get(path) <= 1) {
        converter.applyCoverage(functions)
        map.merge(converter.toIstanbul())
      }
    }

    // if we are running with --all then we create an empty coverage
    // record for any unloaded files
    if (this.all){
      await this._createEmptyRecordsForUnloadedFiles(allFilesMap, map);
    }

    this._allCoverageFiles = map
    return this._allCoverageFiles
  }

  /**
   * Returns source-map and fake source file, if cached during Node.js'
   * execution. This is used to support tools like ts-node, which transpile
   * using runtime hooks.
   *
   * Note: requires Node.js 13+
   *
   * @return {Object} sourceMap and fake source file (created from line #s).
   * @private
   */
  _getSourceMap (v8ScriptCov) {
    const sources = {}
    if (this.sourceMapCache[`file://${v8ScriptCov.url}`]) {
      const sourceMapAndLineLengths = this.sourceMapCache[`file://${v8ScriptCov.url}`]
      sources.sourceMap = {
        sourcemap: sourceMapAndLineLengths.data
      }
      if (sourceMapAndLineLengths.lineLengths) {
        let source = ''
        sourceMapAndLineLengths.lineLengths.forEach(length => {
          source += `${''.padEnd(length, '.')}\n`
        })
        sources.source = source
      }
    }
    return sources
  }

  /**
   * Returns the merged V8 process coverage.
   *
   * The result is computed from the individual process coverages generated
   * by Node. It represents the sum of their counts.
   *
   * @return {ProcessCov} Merged V8 process coverage.
   * @private
   */
  _getMergedProcessCov () {
    const v8ProcessCovs = []
    for (const v8ProcessCov of this._loadReports()) {
      if (this._isCoverageObject(v8ProcessCov)) {
        if (v8ProcessCov['source-map-cache']) {
          Object.assign(this.sourceMapCache, v8ProcessCov['source-map-cache'])
        }
        v8ProcessCovs.push(this._normalizeProcessCov(v8ProcessCov))
      }
    }
    return mergeProcessCovs(v8ProcessCovs)
  }

  /**
   * If --all is supplied we need to fetch a list of files that respects
   * include/exclude that will be used to see the coverage report with
   * empty results
   * @returns {Promise.<Array.<string>>}
   */
  getFileListForAll () {
    return this.exclude.globSync(this.resolve).reduce((allFileList, file) => {
      const fullPath = resolve(this.resolve, file);
      allFileList.set(fullPath, false);
      return allFileList;
    }, new Map())
  }

  /**
   * Iterates over the entries of `allFilesMap` and where an entries' boolean
   * value is false, generate an empty coverage record for the file in question.
   * @param {Map<string, boolean>} allFilesMap where the key is the path to a file
   * read by `--all` and the boolean value indicates a coverage record
   * for this file was found.
   * @param {CoverageMap} coverageMap A coverage map produced from v8's output.
   * If we encounter an unloaded file, it is merged into this CoverageMap
   * @returns {Promise.<undefined>}
   * @private
   */
  async _createEmptyRecordsForUnloadedFiles(allFilesMap, coverageMap){
    for (const [path, seen] of allFilesMap.entries()){
      //if value is false, that means we didn't receive a coverage
      //record. Create and merge an empty record for the file
      if (seen === false){
        const emptyCoverageMap = await this._getEmpyCoverageResultForFile(path);
        coverageMap.merge(emptyCoverageMap)
      }
    }
  }

  /**
   * Uses `v8toIstanbul` to create a CoverageMap to the file with all statements,
   * functions and branches set to unreached
   * @param {string} fullPath
   * @returns {Promise.<CoverageMap>}
   * @private
   */
  async _getEmpyCoverageResultForFile(fullPath){
    const converter = v8toIstanbul(fullPath, this.wrapperLength)
    await converter.load()
    let initialCoverage = converter.toIstanbul()
    initialCoverage = this._setCoverageMapToUncovered(fullPath, initialCoverage);
    return initialCoverage;
  }

  /**
   * v8ToIstanbul will initialize statements to covered until demonstrated to
   * be uncovered. In addition, reporters will interpret empty branch and
   * function counters as 100%. Here we reset line coverage to 0% and create
   * a fake stub entry for branch/functions that will be interpreted as 0%
   * coverage.
   * @param {string} fullPath
   * @param {CoverageMap} coverageMap
   * @returns {CoverageMap}
   * @private
   */
  _setCoverageMapToUncovered(fullPath, coverageMap){
    Object.keys(coverageMap[fullPath].s).forEach((key)=>{
      coverageMap[fullPath].s[key] = 0;
    });
    coverageMap[fullPath].b = {
      0: [
        0
      ]
    }
    coverageMap[fullPath].f = {
      0: false
    }
    return coverageMap;
  }

  /**
   * Make sure v8ProcessCov actually contains coverage information.
   *
   * @return {boolean} does it look like v8ProcessCov?
   * @private
   */
  _isCoverageObject (maybeV8ProcessCov) {
    return maybeV8ProcessCov && Array.isArray(maybeV8ProcessCov.result)
  }

  /**
   * Returns the list of V8 process coverages generated by Node.
   *
   * @return {ProcessCov[]} Process coverages generated by Node.
   * @private
   */
  _loadReports () {
    const files = readdirSync(this.tempDirectory)

    return files.map((f) => {
      try {
        return JSON.parse(readFileSync(
          resolve(this.tempDirectory, f),
          'utf8'
        ))
      } catch (err) {
        console.warn(`${err.stack}`)
      }
    })
  }

  /**
   * Normalizes a process coverage.
   *
   * This function replaces file URLs (`url` property) by their corresponding
   * system-dependent path and applies the current inclusion rules to filter out
   * the excluded script coverages.
   *
   * The result is a copy of the input, with script coverages filtered based
   * on their `url` and the current inclusion rules.
   * There is no deep cloning.
   *
   * @param v8ProcessCov V8 process coverage to normalize.
   * @return {v8ProcessCov} Normalized V8 process coverage.
   * @private
   */
  _normalizeProcessCov (v8ProcessCov) {
    const result = []
    for (const v8ScriptCov of v8ProcessCov.result) {
      if (/^file:\/\//.test(v8ScriptCov.url)) {
        try {
          v8ScriptCov.url = furi.toSysPath(v8ScriptCov.url)
        } catch (err) {
          console.warn(err)
          continue
        }
      }
      if (this.exclude.shouldInstrument(v8ScriptCov.url) &&
        (!this.omitRelative || isAbsolute(v8ScriptCov.url))) {
        result.push(v8ScriptCov)
      }
    }
    return { result }
  }
}

module.exports = function (opts) {
  return new Report(opts)
}
