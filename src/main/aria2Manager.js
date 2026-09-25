const { app } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function resolveBinaryPath() {
  const platform = process.platform;
  const binName = platform === 'win32' ? 'aria2c.exe' : 'aria2c';

  const packagedPath = app.isPackaged
    ? path.join(process.resourcesPath, 'bin', binName)
    : path.join(
        __dirname,
        '..',
        '..',
        'resources',
        'bin',
        platform === 'win32' ? 'win' : 'mac',
        binName
      );

  if (fs.existsSync(packagedPath)) {
    return packagedPath;
  }

  // Dev fallback: rely on a system-installed aria2 (e.g. `brew install aria2`).
  return binName;
}

function resolveCertPath() {
  if (process.platform !== 'darwin') return null;
  const packagedPath = app.isPackaged
    ? path.join(process.resourcesPath, 'certs', 'cacert.pem')
    : path.join(__dirname, '..', '..', 'resources', 'certs', 'cacert.pem');
  if (fs.existsSync(packagedPath)) return packagedPath;

  // Dev fallback: Homebrew's bundle.
  const brewPath = '/opt/homebrew/opt/ca-certificates/share/ca-certificates/cacert.pem';
  if (fs.existsSync(brewPath)) return brewPath;
  const brewPathIntel = '/usr/local/opt/ca-certificates/share/ca-certificates/cacert.pem';
  if (fs.existsSync(brewPathIntel)) return brewPathIntel;
  return null;
}

class Aria2Manager {
  constructor() {
    this.proc = null;
    this.port = null;
    this.secret = null;
    this.ready = false;
    this.userDataDir = app.getPath('userData');
  }

  buildArgs(settings) {
    const sessionFile = path.join(this.userDataDir, 'aria2.session');
    if (!fs.existsSync(sessionFile)) {
      fs.writeFileSync(sessionFile, '', 'utf-8');
    }

    const args = [
      '--enable-rpc=true',
      '--rpc-listen-all=false',
      `--rpc-listen-port=${this.port}`,
      `--rpc-secret=${this.secret}`,
      '--rpc-max-request-size=10M',
      `--stop-with-process=${process.pid}`,
      `--save-session=${sessionFile}`,
      `--input-file=${sessionFile}`,
      '--save-session-interval=30',
      `--dht-file-path=${path.join(this.userDataDir, 'dht.dat')}`,
      `--dht-file-path6=${path.join(this.userDataDir, 'dht6.dat')}`,
      `--log=${path.join(this.userDataDir, 'aria2.log')}`,
      '--log-level=warn',
      '--console-log-level=error',
      '--disable-ipv6=false',
      `--dir=${settings.downloadDir || app.getPath('downloads')}`,
      `--continue=${settings.continueDownload ? 'true' : 'false'}`,
      `--max-concurrent-downloads=${settings.maxConcurrentDownloads}`,
      `--max-connection-per-server=${settings.maxConnectionsPerServer}`,
      `--split=${settings.split}`,
      `--min-split-size=${settings.minSplitSize}`,
      `--max-overall-download-limit=${settings.maxOverallDownloadLimit}`,
      `--max-overall-upload-limit=${settings.maxOverallUploadLimit}`,
      `--max-tries=${settings.maxTries}`,
      `--retry-wait=${settings.retryWait}`,
      `--file-allocation=${settings.fileAllocation}`,
      `--enable-dht=${settings.enableDht ? 'true' : 'false'}`,
      `--bt-max-peers=${settings.btMaxPeers}`,
      `--seed-ratio=${settings.seedRatio}`,
      `--seed-time=${settings.seedTime}`,
      `--check-certificate=${settings.checkCertificate ? 'true' : 'false'}`
    ];

    if (settings.userAgent) args.push(`--user-agent=${settings.userAgent}`);
    if (settings.allProxy) args.push(`--all-proxy=${settings.allProxy}`);

    const certPath = resolveCertPath();
    if (certPath) args.push(`--ca-certificate=${certPath}`);

    if (settings.extraArgs && settings.extraArgs.trim()) {
      // Naive whitespace split is fine here: this is a power-user escape
      // hatch and values needing spaces can use --opt=value form.
      args.push(...settings.extraArgs.trim().split(/\s+/));
    }

    return args;
  }

  async start(settings) {
    this.port = await getFreePort();
    this.secret = crypto.randomBytes(24).toString('hex');
    const bin = resolveBinaryPath();
    const args = this.buildArgs(settings);

    this._stderrTail = '';
    this._exited = false;

    this.proc = spawn(bin, args, { windowsHide: true });
    this.proc.stdout.on('data', () => {});
    this.proc.stderr.on('data', (d) => {
      this._stderrTail = (this._stderrTail + d.toString()).slice(-2000);
    });

    this.proc.on('exit', (code, signal) => {
      this.ready = false;
      this._exited = true;
      if (!this._stopping) {
        console.error(`aria2c exited unexpectedly (code=${code}, signal=${signal})`);
      }
    });

    this.proc.on('error', (err) => {
      console.error('Failed to launch aria2c:', err);
    });

    await this._waitUntilReady();
    this.ready = true;
  }

  async _waitUntilReady(timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this._exited) {
        throw new Error(`aria2c exited before RPC became ready. stderr: ${this._stderrTail || '(empty)'}`);
      }
      try {
        await this.call('getVersion', []);
        return;
      } catch (err) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    throw new Error(`aria2 RPC did not become ready in time. stderr: ${this._stderrTail || '(empty)'}`);
  }

  call(method, params = []) {
    return this._request(`aria2.${method}`, [`token:${this.secret}`, ...params]);
  }

  _request(fullMethod, params) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({
        jsonrpc: '2.0',
        id: 'deyon',
        method: fullMethod,
        params
      });

      const req = http.request(
        {
          host: '127.0.0.1',
          port: this.port,
          path: '/jsonrpc',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
          },
          timeout: 15000
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => {
            try {
              const parsed = JSON.parse(body);
              if (parsed.error) {
                reject(new Error(parsed.error.message || 'aria2 RPC error'));
              } else {
                resolve(parsed.result);
              }
            } catch (err) {
              reject(err);
            }
          });
        }
      );

      req.on('timeout', () => req.destroy(new Error('aria2 RPC request timed out')));
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  async multicall(calls) {
    // calls: [{ methodName: 'aria2.tellActive', params: [...] }, ...]
    const withToken = calls.map((c) => ({
      methodName: c.methodName,
      params: [`token:${this.secret}`, ...(c.params || [])]
    }));
    return this._request('system.multicall', [withToken]);
  }

  async restart(settings) {
    await this.stop();
    await this.start(settings);
  }

  async stop() {
    this._stopping = true;
    if (this.proc && this.ready) {
      try {
        await this.call('saveSession', []);
      } catch (err) {
        // best effort
      }
      try {
        await this.call('shutdown', []);
      } catch (err) {
        // best effort
      }
    }
    if (this.proc) {
      await new Promise((resolve) => {
        const proc = this.proc;
        const timer = setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch (err) {
            // ignore
          }
          resolve();
        }, 3000);
        proc.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    this.proc = null;
    this.ready = false;
    this._stopping = false;
  }
}

module.exports = { Aria2Manager, resolveBinaryPath, resolveCertPath };
