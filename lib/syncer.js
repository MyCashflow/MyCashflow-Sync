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
const Match = require('multimatch')
const Path = require('path')
const Promise = require('bluebird')

/**
 * Promisify dependencies.
 */
Promise.promisifyAll(Fs)
Promise.promisifyAll(Ftp.prototype)

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
  '.DS_Store',
  '.git',
  '.gitignore',
  'bower_components',
  'node_modules',
  'sync.json',
  'temp',
  'Thumbs.db',
  'tmp'
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
  this.queue = []
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
 * @return {undefined}
 */
Syncer.writeConfig = function (data) {
  return Fs.writeFileAsync(this.ConfigPath, this.makeConfig(data))
}

/**
 * Runs sync once and starts watching for changes.
 * @param {boolean} watch
 * @return {undefined}
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
  if (this.ftp) this.ftp.raw.quit()
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
 * Validates the syncer config by its schema.
 * @return {object}
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
  this.pushQueue(path)
  this.workQueue()
    .then(() => {
      const filename = Path.basename(path)
      if (Match(filename, ['*.{css,html,js}']).length) {
        this.bsync.reload()
      }
    })
    .catch(() => {
      const err = Error('Upload failed! If you have created new deeply nested directories, please exit and run sync or watch again.')
      this.exit(err)
    })
}

/**
 * Pushes a local path into the upload queue.
 * @param {string} path
 */
Syncer.prototype.pushQueue = function (path) {
  if (!this.isIgnored([path, Path.basename(path)])) {
    this.queue.push(this.asLocalPath(path))
  }
}

/**
 * Works the upload queue sequentially until it's empty.
 * @return {undefined}
 */
Syncer.prototype.workQueue = function () {
  if (!this.queue.length) {
    return Promise.resolve()
  }
  return this.upload(this.queue.shift())
    .then(this.workQueue())
}

/**
 * Returns true if any of paths is ignored in the config.
 * @param {array} paths
 * @return {boolean}
 */
Syncer.prototype.isIgnored = function (paths) {
  const ignores = BaseIgnores.concat(this.config.sync.ignore)
  return !!Match(paths, ignores).length
}

/**
 * Filters out items that are ignored in the config.
 * @param {array} items
 * @return {array}
 */
Syncer.prototype.wantedOnly = function (items) {
  return items.filter((item) => !this.isIgnored([item.name, item.path]))
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
 * @return {undefined}
 */
Syncer.prototype.createLocalDir = function (path) {
  path = this.asLocalPath(path)
  return Fs.mkdirAsync(path)
}

/**
 * Ensures a directory exists on the local machine.
 * @param {string} path
 * @return {undefined}
 */
Syncer.prototype.ensureLocalDir = function (path) {
  path = this.asLocalPath(path)
  return this.existsLocal(path)
    .catch(() => this.createLocalDir(path))
}

/**
* Returns information if a path exists on the remote machine.
 * @param {string} path
 * @return {object}
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
 * @return {undefined}
 */
Syncer.prototype.createRemoteDir = function (path) {
  path = this.asRemotePath(path)
  return this.ftp.raw.mkd(path)
}

/**
 * Ensures a directory exists on the remote machine.
 * @param {string} path
 * @return {undefined}
 */
Syncer.prototype.ensureRemoteDir = function (path) {
  path = this.asRemotePath(path)
  return this.existsRemote(path)
    .catch(() => this.createRemoteDir(path))
}

/**
 * Returns a file list from a path on the local machine.
 * @param {string} path
 * @return {array}
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
   path = path.replace(process.cwd(), '.')
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
 * @return {undefined}
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
 * @return {undefined}
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
 * @return {undefined}
 */
Syncer.prototype.sync = function (items) {
  items = this.wantedOnly(items)
  return this.syncFiles(items)
    .then(() => this.syncDirs(items))
}

/**
 * Syncs a file between the local and the remote machine.
 * @param {string} path
 * @return {undefined}
 */
Syncer.prototype.syncFile = function (item) {
  return item.from === 'local' ? this.upload(item.path) : this.download(item.path)
}

/**
* Syncs a directory between the local and the remote machine.
 * @param {string} path
 * @return {undefined}
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
 * @return {undefined}
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