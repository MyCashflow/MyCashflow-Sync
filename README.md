# MyCashflow Sync

Synchronizes MyCashflow theme files over FTP automatically, refreshing the browser after every CSS/HTML/JS change.

---

## Installation

```
npm install -g mycashflow-sync --silent --no-optional
```

Installs the command-line application.

---

## Usage

1. Enable the Web Designer extension in your shop
2. Create an empty directory or cd into an existing one
3. Run the init script to generate a config for the directory
4. Happy syncing!

Like this...

```
0. mkdir theme-directory
1. cd theme-directory
2. mycashflow-sync init
3. mycashflow-sync [sync|watch]
```

### Notes

Make sure that the development mode is on in your templates!

```
{MinifyCSS(files: ..., mode: 'development')}
```

---

## Commands

### Initialization

Initializes a new configuration file inside the current directory.

```
mcf-sync init
```

### Sync

**Non-destructive, i.e. will NOT remove any files, but keeps only the newer file.**

Syncs the files between the local and the remote machines.

```
mcf-sync sync
```

### Watch

Syncs local changes to the remote machine automatically.

```
mcf-sync watch
```

---

## Configuration

You can configure the syncing through `sync.json`.

### Example config

```
{
  "ftp": {
    "host": "ftp.mycashflow.fi",
    "port": 21,
    "user": "<username>",
    "pass": "<password>"
  },
  "sync": {
    "url": "<shop url>",
    "path": "<remote path>",
    "ignore": [
      "*.scss",
      "*.css.map"
    ]
  },
  "sass": {
    "source": "scss",
    "dest": "css"
  }
}
```

**Sass** paths are optional, and Sass files won't be compiled if you don't provide the Sass paths.

### FTP settings

You can find these settings on your shop's **Web Designer** extension admin page.

| Option  | Description         |
|---------|---------------------|
| host    | FTP server hostname |
| port    | FTP server port     |
| user    | FTP server username |
| pass    | FTP server password |

### Sync settings

Make sure your shop version is using the theme directory defined in the remote path.

| Option  | Description        |
|---------|--------------------|
| url     | Shop's URL         |
| path    | Shop's theme path  |
| ignore  | Patterns to ignore |
