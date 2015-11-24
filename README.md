# MyCashflow Sync

Synchronizes MyCashflow theme files over FTP automatically, refreshing the browser after every CSS/HTML/JS change.

---

## Installation

```
npm install -g mycashflow-sync
```

Installs the command-line application.

---

## Usage

```
1. cd theme-directory
2. mcf-sync init
3. mcf-sync [sync|watch]
```

---

## Commands

### Initialization

Initializes a new configuration file inside the current directory.

```
mcf-sync init
```

### Sync

Syncs the files between the local and the remote machines. **Non-destructive, i.e. will NOT remove files!**

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

You can configure the syncing through `mcf-sync.json`.

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
    "proxy": "<shop url>",
    "remote": "<remote path>",
    "ignore": [
      "<ignore pattern>",
      "<ignore pattern>"
    ]
  }
}
```

### FTP settings

You can find these settings on your shop's **Web Designer** extension admin page.

| Option  | Description         |
|---------|---------------------|
| host    | FTP server hostname |
| port    | FTP server port     |
| user    | FTP server username |
| pass    | FTP server password |

### Sync settings

Make sure your shop URL & version is using the theme directory defined in the remote path.

| Option  | Description              |
|---------|--------------------------|
| proxy   | Shop's URL to proxy      |
| remote  | Theme path on the server |
| ignore  | Patterns to ignore       |
