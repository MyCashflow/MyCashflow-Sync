#!/usr/bin/env node

const Fs = require('fs')
const Program = require('commander')
const Prompt = require('prompt')
const Syncer = require('../lib/syncer')

Program.version('0.1.7')
Prompt.colors = false
Prompt.message = '> '.green
Prompt.delimiter = ''

Program.command('init')
  .description('Initialize config file')
  .action(() => {
    const schema = {
      properties: {
        ftp: {
          properties: {
            host: { message: 'FTP host', required: true, default: 'ftp.mycashflow.fi' },
            port: { message: 'FTP port', required: true, default: 21 },
            user: { message: 'FTP user', required: true },
            pass: { message: 'FTP pass', required: true }
          }
        },
        sync: {
          properties: {
            url: { message: 'Remote URL (e.g. https://shop.mycashflow.fi)', required: true },
            path: { message: 'Remote path (e.g. theme-name)', required: true }
          }
        }
      }
    }

    Fs.lstat(Syncer.ConfigPath, (err, stats) => {
      if (stats) {
        console.log('Config file already exists!'.red)
        process.exit(0)
      }

      console.log('\nBefore you start!'.yellow)
      console.log('> You can find the FTP settings on your shop\'s Web Designer extension admin page.')
      console.log('> The remote path is a relative path to your theme directory on the server!')
      console.log('> You can exit this program anytime by pressing CMD/CTRL+C.')

      Prompt.start()
      Prompt.get(schema, function (err, config) {
        if (err) throw Error(err)
        config.ftp.port = parseInt(config.ftp.port)
        Syncer.writeConfig(config)
      })
    })
  })

Program.command('sync')
  .description('Synchronize files between local & remote')
  .action(() => {
    const syncer = new Syncer()
    syncer.init()
  })

Program.command('watch')
  .description('Synchronize local changes automatically')
  .action(() => {
    const syncer = new Syncer()
    syncer.init(true)
  })

Program.parse(process.argv)
process.on('uncaughtException', () => process.exit(0))
