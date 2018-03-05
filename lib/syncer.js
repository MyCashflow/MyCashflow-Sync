'use strict'

/**
 * Module dependencies.
 */
require('colors')
const _ = require('lodash')
const Bsync = require('browser-sync')
const Fs = require('fs')
const Ftp = require('jsftp')
const Joi = require('joi')
const Ignore = require('ignore')
const Path = require('path')
const Promise = require('bluebird')
const Sass = require('node-sass')

/**
 * Promisify dependencies.
 */
Promise.promisifyAll(Fs)
Promise.promisifyAll(Ftp.prototype)
Promise.promisifyAll(Sass)

/**
 * FTP server file types.
 */
const RemoteFileTypes = {
  0: 'file',
  1: 'directory'
}

/**
 * Base ignore items.
 */
const BaseIgnores = [
  '.git',
  '.sass-cache',
  'bower_components',
  'node_modules',
  'temp',
  'tmp',

  '._*',
  '.DS_Store',
  '.gitignore',
  '.Spotlight-v100',
  '.Trashes',
  'sync.json',
  'Thumbs.db'
]

/**
 * Syncer config schema.
 */
const ConfigSchema = Joi.object().keys({
  ftp: Joi.object().keys({
    host: Joi.string().required(),
    port: Joi.number().required(),
    user: Joi.string().required(),
    pass: Joi.string().required()
  }),
  sync: Joi.object().keys({
    url: Joi.string().required(),
    path: Joi.string().required(),
    ignore: Joi.array().items(Joi.string()).required()
  }),
  sass: Joi.object().keys({
    source: Joi.string(),
    dest: Joi.string()
  })
})

ConfigSchema.validateAsync = Promise.promisify(ConfigSchema.validate)

/**
 * BrowserSync defaults.
 */
const BsyncConfig = {
  notify: false,
  logLevel: 'silent'
}

/**
 * Represents a single syncer instance.
 */
function Syncer(config) {
  this.config = config ? config : require(Syncer.ConfigPath)
  this.ignore = Ignore().addPattern(BaseIgnores).addPattern(this.config.sync.ignore)
  this.queue = []
  this.working = false
}

/**
 * Default syncer config file path.
 */
Syncer.ConfigPath = `${process.cwd()}/sync.json`

/**
 * Creates a syncer config object from data.
 * @param {object} data
 * @return {string}
 */
Syncer.makeConfig = function (data) {
  const blueprint = require('./config.json')
  const config = _.merge({}, blueprint, data)
  return JSON.stringify(config, null, 2)
}

/**
 * Writes a config object into the config file.
 * @param {object} data
 * @return {Promise}
 */
Syncer.writeConfig = function (data) {
  return Fs.writeFileAsync(this.ConfigPath, this.makeConfig(data))
}

/**
 * Runs sync once and starts watching for changes.
 * @param {boolean} watch
 * @return {Promise}
 */
Syncer.prototype.init = function (watch) {
  this.validateConfig()
    .then(() => this.initFtp())
    .then(() => this.syncDir('.'))
    .then(() => watch ? this.initBsync() : this.exit())
    .catch((err) => this.exit(err))
}

/**
 * Stops the syncer instance.
 * @return {undefined}
 */
Syncer.prototype.exit = function (err) {
  if (err) console.log(`${err.name.white}: ${err.message.red}`)
  if (this.ftp) this.ftp.raw('quit')
  process.exit(err ? 1 : 0)
}

/**
 * Initializes the JsFTP client.
 * @return {undefined}
 */
Syncer.prototype.initFtp = function () {
  this.ftp = new Ftp(this.config.ftp)
}

/**
 * Initializes the BrowserSync server.
 * @return {undefined}
 */
Syncer.prototype.initBsync = function () {
  this.bsync = Bsync.create()
  this.bsync.init(_.merge({}, BsyncConfig, { proxy: this.config.sync.url }))
  this.bsync.watch(`${process.cwd()}/**/*`).on('change', this.onFileChange.bind(this))
}

/**
 * Requests the BrowserSync for a reload.
 */
Syncer.prototype.reloadBsync = function (path) {
  const filename = Path.basename(path)
  if (['.css', '.html', '.js'].indexOf(Path.extname(filename)) !== -1) {
    this.bsync.reload(this.asRemotePath(path))
  }
}

/**
 * Compiles project Sass files.
 * @return {Promise}
 */
Syncer.prototype.compileSass = function () {
  const sassConfig = this.config.sass

  function validateSassConfig() {
    return new Promise((resolve, reject) => {
      if (!sassConfig || !sassConfig.source || !sassConfig.dest) {
        reject(Error('Sass paths are not configured!'))
      } else if (sassConfig.source === sassConfig.dest) {
        reject(Error('Sass paths cannot be the same!'))
      }
      resolve()
    })
  }

  function isSassFile(file) {
    return file.name.indexOf('_') !== 0 && !!file.path.match(/.scss$/g)
  }

  function renderSass(file) {
    const data = Fs.readFileSync(file.path, 'utf8')
    return Sass.renderAsync({ data: data || ';', includePaths: [Path.join(process.cwd(), sassConfig.source)] })
      .catch((err) => { throw err })
      .then((sass) => { return { file, sass } })
  }

  function writeCssFile(compiled) {
    const cssPath = compiled.file.path.replace('.scss', '.css')
      .replace(`${sassConfig.source}`, `${sassConfig.dest}`)
    return Fs.writeFileAsync(cssPath, compiled.sass.css, 'utf8')
  }

  return validateSassConfig()
    .then(() => this.listLocal(sassConfig.source))
    .then((files) => files.filter(isSassFile))
    .then((files) => Promise.mapSeries(files, renderSass))
    .catch((err) => { throw err })
    .then((files) => Promise.mapSeries(files, writeCssFile))
}

/**
 * Validates the syncer config by its schema.
 * @return {Promise}
 */
Syncer.prototype.validateConfig = function () {
  return ConfigSchema.validateAsync(this.config)
}

/**
 * Queues a path an upload, auto-refreshing the
 * browser(s) after the uploads have completed.
 * @param {string} path
 * @return {undefined}
 */
Syncer.prototype.onFileChange = function (path) {
  path = this.asLocalPath(path)

  const sassFileChanged = !!this.config.sass && path.indexOf(`./${this.config.sass.source}`) === 0
  if (sassFileChanged) {
    this.compileSass().catch((err) => {
      console.log('[SASS]'.white + ' ' + (err.formatted || err.toString()).red)
    })
  }

  this.pushQueue(path)
  if (!this.working) {
    this.workQueue()
  }
}

/**
 * Pushes a local path into the upload queue.
 * @param {string} path
 * @return {undefined}
 */
Syncer.prototype.pushQueue = function (path) {
  if (!this.isIgnored(path)) {
    this.queue.push(this.asLocalPath(path))
  }
}

/**
 * Works the upload queue sequentially until it's empty.
 * @return {Promise}
 */
Syncer.prototype.workQueue = function () {
  if (!this.queue.length) {
    this.working = false
    return Promise.resolve()
  }

  this.working = true
  const path = this.queue.shift()
  return this.upload(path)
    .catch(() => this.ensureRemoteDirs(path))
    .then(() => this.reloadBsync(path))
    .then(() => this.workQueue())
    .catch(() => {
      this.exit(new Error('Upload failed! This usually happens' +
        'if you have created new deeply nested directories on' +
        'the local machine, please run sync or watch again.'))
    })
}

/**
 * Returns true if a path is ignored in the config.
 * @param {array} paths
 * @return {boolean}
 */
Syncer.prototype.isIgnored = function (path) {
  return !this.ignore.filter([path]).length
}

/**
 * Filters out items that are ignored in the config.
 * @param {array} items
 * @return {array}
 */
Syncer.prototype.wantedOnly = function (items) {
  return items.filter((item) => !this.isIgnored(item.path))
}

/**
 * Filters out items that are not files.
 * @param {array} items
 * @return {array}
 */
Syncer.prototype.filesOnly = function (items) {
  return items.filter((item) => item.type === 'file')
}

/**
 * Filters out items that are not directories.
 * @param {array} items
 * @return {array}
 */
Syncer.prototype.dirsOnly = function (items) {
  return items.filter((item) => item.type === 'directory')
}

/**
 * Returns information about a path on the local machine.
 * @param {string} path
 * @return {object}
 */
Syncer.prototype.getLocalDetails = function (path) {
  path = this.asLocalPath(path)
  return Fs.lstatAsync(path)
    .then((stats) => this.asLocalFile(path, stats))
}

/**
 * Returns information if a path exists on the local machine.
 * @param {string} path
 * @return {object}
 */
Syncer.prototype.existsLocal = function (path) {
  path = this.asLocalPath(path)
  return Fs.lstatAsync(path)
}

/**
 * Creates a directory by path on the local machine.
 * @param {string} path
 * @return {Promise}
 */
Syncer.prototype.createLocalDir = function (path) {
  path = this.asLocalPath(path)
  return Fs.mkdirAsync(path)
}

/**
 * Ensures a directory exists on the local machine.
 * @param {string} path
 * @return {Promise}
 */
Syncer.prototype.ensureLocalDir = function (path) {
  path = this.asLocalPath(path)
  return this.existsLocal(path)
    .catch(() => this.createLocalDir(path))
}

/**
 * Returns information if a path exists on the remote machine.
 * @param {string} path
 * @return {Promise}
 */
Syncer.prototype.existsRemote = function (path) {
  path = this.asRemotePath(path)
  return this.ftp.lsAsync(path)
    .then((list) => {
      if (!list.length) {
        throw new Error(`Remote path ${path} doesn' exist!`)
      }
    })
}

/**
 * Creates a directory by path on the remote machine.
 * @param {string} path
 * @return {Promise}
 */
Syncer.prototype.createRemoteDir = function (path) {
  path = this.asRemotePath(path)
  return this.ftp.raw('mkd', path)
}

/**
 * Ensures a directory exists on the remote machine.
 * @param {string} path
 * @return {Promise}
 */
Syncer.prototype.ensureRemoteDir = function (path) {
  path = this.asRemotePath(path)
  return this.existsRemote(path)
    .catch(() => this.createRemoteDir(path))
}

/**
 * Ensures a directory exists on the remote machine recursively (SLOW!).
 * @param {string} path
 * @return {Promise}
 */
 Syncer.prototype.ensureRemoteDirs = function (path) {
   const parts = path.split('/')
   return Promise.mapSeries(parts, (part, index) => {
     const currPath = parts.slice(0, index).join('/')
     return this.ensureRemoteDir(currPath)
   })
 }

/**
 * Returns a file list from a path on the local machine.
 * @param {string} path
 * @return {Promise}
 */
Syncer.prototype.listLocal = function (path) {
  path = this.asLocalPath(path)
  return Fs.readdirAsync(path)
    .then((files) => files.map((file) => `${path}/${file}`))
    .then((paths) => Promise.map(paths, (path) => this.getLocalDetails(path)))
}

/**
 * Returns a file list from a path on the remote machine.
 * @param {string} path
 * @return {array}
 */
Syncer.prototype.listRemote = function (path) {
  path = this.asRemotePath(path)
  return this.ftp.lsAsync(path)
    .then((items) => items.map((item) => this.asRemoteFile(path, item)))
}

/**
 * Normalizes file information received from the local machine.
 * @param {string} path
 * @param {object} stats
 * @return {object}
 */
Syncer.prototype.asLocalFile = function (path, info) {
  return {
    from: 'local',
    type: info.isFile() ? 'file' : 'directory',
    name: Path.basename(path),
    path: path,
    size: info.size,
    time: info.mtime.valueOf()
  }
}

/**
 * Normalizes file information received from the remote machine.
 * @param {string} path
 * @param {object} stats
 * @return {object}
 */
Syncer.prototype.asRemoteFile = function (path, info) {
  return {
    from: 'remote',
    type: RemoteFileTypes[info.type],
    name: info.name,
    path: [path, info.name].join('/'),
    size: parseInt(info.size),
    time: parseInt(info.time)
  }
}

/**
 * Converts a path into a local path.
 * @param {string} path
 * @return {string}
 */
 Syncer.prototype.asLocalPath = function (path) {
   path = path.replace(process.cwd(), '.').replace(/\\/g, '/')
   const parts = path.split('/')
   if (parts[0] === this.config.sync.path) {
     parts[0] = '.'
   }
   return parts.join('/')
 }

/**
 * Converts a path into a remote path.
 * @param {string} path
 * @return {string}
 */
 Syncer.prototype.asRemotePath = function (path) {
   const parts = path.split('/')
   if (parts[0] === '.') {
     parts[0] = this.config.sync.path
   }
   return parts.join('/')
 }

/**
 * Downloads a file from the remote machine.
 * @param {string} path
 * @return {Promise}
 */
Syncer.prototype.download = function (path) {
  console.log('[DOWN]'.white + ' ' + path.yellow)
  const localPath = this.asLocalPath(path)
  return this.ensureLocalDir(Path.dirname(localPath))
    .then(() => this.ftp.getAsync(path, localPath))
}

/**
 * Uploads a file to the remote machine.
 * @param {string} path
 * @return {Promise}
 */
Syncer.prototype.upload = function (path) {
  console.log('[UPLD]'.white + ' ' + path.yellow)
  const remotePath = this.asRemotePath(path)
  return this.ensureRemoteDir(Path.dirname(remotePath))
    .then(() => this.ftp.putAsync(path, remotePath))
}

/**
 * Collects syncable items for path from both machines.
 * @param {string} path
 * @return {array}
 */
Syncer.prototype.getSyncItems = function (path) {
  const items = []
  const added = {}

  function addSyncables(itemsA, itemsB) {
    itemsA.forEach((a) => {
      if (added[a.name]) {
        return
      }
      const b = itemsB.find((c) => a.name === c.name)
      if (a.type === 'directory' || !b) {
        items.push(a)
      } else if (a.size !== b.size) {
        items.push(a.time > b.time ? a : b)
      }
      added[a.name] = true
    })
  }

  return Promise.all([this.listLocal(path), this.listRemote(path)])
    .spread((localItems, remoteItems) => {
      addSyncables(localItems, remoteItems)
      addSyncables(remoteItems, localItems)
      return items
    })
}

/**
 * Processes an array of files, syncing files and directories sequentially.
 * @param {array} items
 * @return {Promise}
 */
Syncer.prototype.sync = function (items) {
  items = this.wantedOnly(items)
  return this.syncFiles(items)
    .then(() => this.syncDirs(items))
}

/**
 * Syncs a file between the local and the remote machine.
 * @param {string} path
 * @return {Promise}
 */
Syncer.prototype.syncFile = function (item) {
  return item.from === 'local' ? this.upload(item.path) : this.download(item.path)
}

/**
 * Syncs a directory between the local and the remote machine.
 * @param {string} path
 * @return {Promise}
 */
Syncer.prototype.syncDir = function (path) {
  console.log('[SYNC]'.white + ' ' + path.yellow)
  return Promise.all([this.ensureLocalDir(path), this.ensureRemoteDir(path)])
    .then(() => this.getSyncItems(path))
    .then((items) => this.sync(items))
}

/**
 * Syncs an array of files between the local and the remote machine.
 * @param {array} items
 * @return {Promise}
 */
Syncer.prototype.syncFiles = function (items) {
  return Promise.mapSeries(this.filesOnly(items), (item) => {
    return this.syncFile(item)
  })
}

/**
  * Syncs an array of directories between the local and the remote machine.
 * @param {array} items
 * @return {undefined}
 */
Syncer.prototype.syncDirs = function (items) {
  return Promise.mapSeries(this.dirsOnly(items), (item) => {
    return this.syncDir(item.path)
  })
}

module.exports = Syncer
