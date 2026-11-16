import dgram from 'node:dgram';
import net from 'node:net';

export class NetworkBlockedError extends Error {
  constructor(what: string) {
    super(`Network access is blocked in tests: ${what}`);
    this.name = 'NetworkBlockedError';
  }
}

const CREDENTIAL_NAME = /TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE|AUTH|API_KEY|_KEY$|^PAT$|_PAT$|DATABASE_URL|DSN/i;

export function clearCredentialEnv(env: NodeJS.ProcessEnv): string[] {
  const removed = Object.keys(env).filter((name) => CREDENTIAL_NAME.test(name));
  for (const name of removed) delete env[name];
  return removed;
}

clearCredentialEnv(process.env);

globalThis.fetch = () => Promise.reject(new NetworkBlockedError('fetch'));

net.Socket.prototype.connect = function connect(): never {
  throw new NetworkBlockedError('socket connect');
};

dgram.Socket.prototype.send = function send(): never {
  throw new NetworkBlockedError('udp send');
};
