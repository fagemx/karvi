/**
 * tunnel.js — SSH Reverse Tunnel Manager
 *
 * 使用 Node.js 內建 child_process 模組建立 SSH reverse tunnel，
 * 讓本地 Karvi server 可從外部存取（手機遠端監控/審批）。
 *
 * 用法：
 *   const tunnel = require('./tunnel');
 *   const t = tunnel.create({ relayHost: 'relay.example.com', localPort: 3461 });
 *   t.start();
 *   // t.stop() 在 shutdown 時呼叫
 *
 * 需求：
 *   - 目標 relay server 必須允許 SSH remote port forwarding
 *   - 使用者需預先設定 SSH key 認證（免密碼登入）
 *   - relay server 的 /etc/ssh/sshd_config 需設定 GatewayPorts yes
 */
const { spawn } = require('child_process');
const net = require('net');

const DEFAULT_SSH_PORT = 22;
const RECONNECT_DELAY_MS = 5000;
const MAX_RECONNECT_ATTEMPTS = 10;

function createTunnel(opts) {
  const {
    relayHost,
    remotePort = 0,
    localPort = 3461,
    sshPort = DEFAULT_SSH_PORT,
    sshUser = null,
    identityFile = null,
    onStatusChange = null,
  } = opts;

  let tunnelProcess = null;
  let reconnectAttempts = 0;
  let isShuttingDown = false;
  let actualRemotePort = remotePort;
  let status = 'stopped';

  function updateStatus(newStatus, info) {
    status = newStatus;
    if (onStatusChange) {
      try { onStatusChange(newStatus, info); } catch {}
    }
  }

  function buildArgs() {
    const args = [
      '-N',
      '-T',
      '-R',
      remotePort === 0 ? `0:localhost:${localPort}` : `${remotePort}:localhost:${localPort}`,
      '-p', String(sshPort),
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'StrictHostKeyChecking=accept-new',
    ];

    if (identityFile) {
      args.push('-i', identityFile);
    }

    const userPrefix = sshUser ? `${sshUser}@` : '';
    args.push(`${userPrefix}${relayHost}`);

    return args;
  }

  function start() {
    if (!relayHost) {
      const err = new Error('relayHost is required');
      updateStatus('error', { error: err.message });
      return err;
    }

    if (tunnelProcess) {
      return new Error('tunnel already running');
    }

    isShuttingDown = false;
    const args = buildArgs();

    updateStatus('connecting', { relayHost, localPort });

    const nodeProcess = global.process;
    const sshCmd = nodeProcess.platform === 'win32' ? 'ssh.exe' : 'ssh';
    tunnelProcess = spawn(sshCmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    tunnelProcess.stdout.on('data', (data) => {
      const line = data.toString().trim();
      if (line) {
        console.log(`[tunnel:stdout] ${line}`);
        const portMatch = line.match(/Allocated port (\d+) for remote forward/);
        if (portMatch) {
          actualRemotePort = parseInt(portMatch[1], 10);
          updateStatus('connected', { relayHost, remotePort: actualRemotePort, localPort });
          console.log(`[tunnel] connected: ${relayHost}:${actualRemotePort} -> localhost:${localPort}`);
        }
      }
    });

    tunnelProcess.stderr.on('data', (data) => {
      const line = data.toString().trim();
      if (line) {
        console.error(`[tunnel:stderr] ${line}`);
        if (line.includes('Allocated port')) {
          const portMatch = line.match(/Allocated port (\d+)/);
          if (portMatch) {
            actualRemotePort = parseInt(portMatch[1], 10);
            updateStatus('connected', { relayHost, remotePort: actualRemotePort, localPort });
            console.log(`[tunnel] connected: ${relayHost}:${actualRemotePort} -> localhost:${localPort}`);
          }
        }
      }
    });

    tunnelProcess.on('error', (err) => {
      console.error(`[tunnel] process error: ${err.message}`);
      tunnelProcess = null;
      updateStatus('error', { error: err.message });
      if (!isShuttingDown) {
        scheduleReconnect();
      }
    });

    tunnelProcess.on('close', (code, signal) => {
      console.log(`[tunnel] process closed: code=${code}, signal=${signal}`);
      tunnelProcess = null;
      if (!isShuttingDown && code !== 0) {
        updateStatus('disconnected', { code, signal });
        scheduleReconnect();
      } else if (!isShuttingDown) {
        updateStatus('stopped', { code, signal });
      }
    });

    if (remotePort !== 0) {
      setTimeout(() => {
        if (status === 'connecting') {
          actualRemotePort = remotePort;
          updateStatus('connected', { relayHost, remotePort: actualRemotePort, localPort });
          console.log(`[tunnel] assumed connected: ${relayHost}:${actualRemotePort} -> localhost:${localPort}`);
        }
      }, 2000);
    }

    reconnectAttempts = 0;
    return null;
  }

  function scheduleReconnect() {
    if (isShuttingDown) return;
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error(`[tunnel] max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached`);
      updateStatus('error', { error: 'max reconnect attempts reached' });
      return;
    }
    reconnectAttempts++;
    const delay = RECONNECT_DELAY_MS * reconnectAttempts;
    console.log(`[tunnel] reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
    updateStatus('reconnecting', { attempt: reconnectAttempts, delay });
    setTimeout(() => {
      if (!isShuttingDown && !tunnelProcess) {
        start();
      }
    }, delay);
  }

  function stop() {
    isShuttingDown = true;
    if (tunnelProcess) {
      console.log('[tunnel] stopping...');
      tunnelProcess.kill('SIGTERM');
      tunnelProcess = null;
    }
    updateStatus('stopped', {});
  }

  function getStatus() {
    return {
      status,
      relayHost,
      localPort,
      remotePort: actualRemotePort,
      reconnectAttempts,
    };
  }

  return {
    start,
    stop,
    getStatus,
  };
}

function checkLocalAccess(req) {
  const socketAddr = req.socket.remoteAddress || '';
  const localPatterns = ['::1', '::ffff:127.', '127.', 'localhost'];
  for (const p of localPatterns) {
    if (socketAddr.includes(p)) return true;
  }
  return false;
}

module.exports = {
  createTunnel,
  checkLocalAccess,
  DEFAULT_SSH_PORT,
  RECONNECT_DELAY_MS,
  MAX_RECONNECT_ATTEMPTS,
};
