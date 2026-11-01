// Kleiner SMTP-Server für Tests: nimmt Nachrichten an und merkt sie sich, statt sie zu verschicken.
// STARTTLS oder TLS ab der ersten Zeile (wie Port 465), Anmeldung mit PLAIN, LOGIN oder CRAM-MD5,
// und auf Wunsch Fehler an jeder Stelle (Begrüßung, STARTTLS, Anmeldung, Empfänger, Inhalt).
import net from 'node:net';
import tls from 'node:tls';
import { createHmac, randomBytes } from 'node:crypto';

export interface SinkBehavior {
  greeting?: string; // statt "220 …"
  startTls?: boolean; // STARTTLS anbieten (nur ohne TLS ab der ersten Zeile)
  authMethods?: string[]; // angebotene Verfahren, [] = kein AUTH
  rejectAuth?: boolean;
  rejectRcpt?: boolean;
  rejectData?: boolean;
  noEhlo?: boolean; // nur HELO
}

export interface SinkSession {
  side: string;
  secure: boolean;
  hello: string[];
  auth: { method: string; user: string; pass: string } | null;
  authAttempts: string[];
  mailFrom: string | null;
  rcpt: string[];
  data: Buffer | null;
  commands: string[];
}

export class SmtpSink {
  sessions: SinkSession[] = [];
  side = '';
  behavior: SinkBehavior = {};
  private servers: net.Server[] = [];

  constructor(private readonly creds: { user: string; pass: string }, private readonly cert: { key: string | Buffer; cert: string | Buffer }) {}

  setCreds(user: string, pass: string): void {
    this.creds.user = user;
    this.creds.pass = pass;
  }

  // Lauschen; implicitTls = TLS ab der ersten Zeile. Gibt den Port zurück.
  listen(host: string, port: number, implicitTls: boolean): Promise<number> {
    const server = implicitTls
      ? tls.createServer({ key: this.cert.key, cert: this.cert.cert }, (s) => this.session(s, true))
      : net.createServer((s) => this.session(s, false));
    this.servers.push(server);
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve((server.address() as net.AddressInfo).port));
    });
  }

  close(): Promise<void> {
    return Promise.all(this.servers.map((s) => new Promise<void>((r) => s.close(() => r())))).then(() => undefined);
  }

  private session(socket: net.Socket, secure: boolean): void {
    const b = this.behavior;
    const rec: SinkSession = { side: this.side, secure, hello: [], auth: null, authAttempts: [], mailFrom: null, rcpt: [], data: null, commands: [] };
    this.sessions.push(rec);
    let sock: net.Socket = socket;
    let buf = Buffer.alloc(0);
    let inData = false;
    let pending: ((line: string) => void) | null = null;
    const send = (line: string) => sock.write(line + '\r\n');
    const ehloLines = (): string[] => {
      const ext: string[] = ['8BITMIME'];
      if (!rec.secure && b.startTls) ext.push('STARTTLS');
      const methods = b.authMethods ?? ['PLAIN', 'LOGIN'];
      if ((rec.secure || !b.startTls) && methods.length) ext.push('AUTH ' + methods.join(' '));
      return ['sink.test', ...ext];
    };
    const finishAuth = (method: string, user: string, pass: string, ok: boolean) => {
      rec.authAttempts.push(method);
      if (ok && !b.rejectAuth) {
        rec.auth = { method, user, pass };
        send('235 2.7.0 Authentication successful');
      } else {
        send('535 5.7.8 Authentication failed');
      }
    };
    const onLine = (line: string) => {
      if (pending) {
        const p = pending;
        pending = null;
        p(line);
        return;
      }
      rec.commands.push(line.replace(/^(AUTH \S+) .*/i, '$1 …'));
      const [verb, ...rest] = line.split(' ');
      const arg = rest.join(' ');
      switch (verb.toUpperCase()) {
        case 'EHLO':
          if (b.noEhlo) return send('502 5.5.2 Command not recognized');
          rec.hello.push(line);
          {
            const lines = ehloLines();
            lines.forEach((l, i) => send((i === lines.length - 1 ? '250 ' : '250-') + l));
          }
          return;
        case 'HELO':
          rec.hello.push(line);
          return send('250 sink.test');
        case 'STARTTLS': {
          if (rec.secure || !b.startTls) return send('502 5.5.1 STARTTLS not available');
          send('220 2.0.0 Ready to start TLS');
          sock.removeAllListeners('data');
          const secured = new tls.TLSSocket(sock, { isServer: true, key: this.cert.key, cert: this.cert.cert });
          secured.on('error', () => undefined);
          secured.on('data', onData);
          sock = secured;
          rec.secure = true;
          buf = Buffer.alloc(0);
          return;
        }
        case 'AUTH': {
          const [method, initial] = arg.split(' ');
          const m = (method || '').toUpperCase();
          const offered = (b.authMethods ?? ['PLAIN', 'LOGIN']).includes(m);
          if (!offered) return send('504 5.5.4 Unrecognized authentication type');
          if (m === 'PLAIN') {
            const check = (b64: string) => {
              const [, user = '', pass = ''] = Buffer.from(b64, 'base64').toString('utf8').split('\0');
              finishAuth('PLAIN', user, pass, user === this.creds.user && pass === this.creds.pass);
            };
            if (initial) return check(initial);
            send('334 ');
            pending = check;
            return;
          }
          if (m === 'LOGIN') {
            const askPass = (userB64: string) => {
              const user = Buffer.from(userB64, 'base64').toString('utf8');
              send('334 UGFzc3dvcmQ6');
              pending = (passB64) => {
                const pass = Buffer.from(passB64, 'base64').toString('utf8');
                finishAuth('LOGIN', user, pass, user === this.creds.user && pass === this.creds.pass);
              };
            };
            if (initial) return askPass(initial);
            send('334 VXNlcm5hbWU6');
            pending = askPass;
            return;
          }
          if (m === 'CRAM-MD5') {
            const challenge = `<${randomBytes(8).toString('hex')}@sink.test>`;
            send('334 ' + Buffer.from(challenge).toString('base64'));
            pending = (resp) => {
              const [user, digest] = Buffer.from(resp, 'base64').toString('utf8').split(' ');
              const want = createHmac('md5', this.creds.pass).update(challenge).digest('hex');
              finishAuth('CRAM-MD5', user, digest === want ? this.creds.pass : '(wrong)', user === this.creds.user && digest === want);
            };
            return;
          }
          return send('504 5.5.4 Unrecognized authentication type');
        }
        case 'MAIL':
          rec.mailFrom = /<([^>]*)>/.exec(arg)?.[1] ?? arg;
          return send('250 2.1.0 Ok');
        case 'RCPT':
          if (b.rejectRcpt) return send('550 5.1.1 Recipient rejected');
          rec.rcpt.push(/<([^>]*)>/.exec(arg)?.[1] ?? arg);
          return send('250 2.1.5 Ok');
        case 'DATA':
          inData = true;
          return send('354 End data with <CR><LF>.<CR><LF>');
        case 'RSET':
          return send('250 2.0.0 Ok');
        case 'NOOP':
          return send('250 2.0.0 Ok');
        case 'QUIT':
          send('221 2.0.0 Bye');
          sock.end();
          return;
        default:
          return send('502 5.5.2 Command not recognized');
      }
    };
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          const atStart = buf.subarray(0, 3).toString() === '.\r\n';
          if (end < 0 && !atStart) return;
          const raw = atStart ? Buffer.alloc(0) : buf.subarray(0, end + 2);
          buf = atStart ? buf.subarray(3) : buf.subarray(end + 5);
          inData = false;
          // Punkte am Zeilenanfang wieder entfernen
          rec.data = Buffer.from(raw.toString('latin1').replace(/^\.\./gm, '.'), 'latin1');
          send(b.rejectData ? '554 5.6.0 Message rejected' : '250 2.0.0 Ok: queued');
          continue;
        }
        const i = buf.indexOf('\r\n');
        if (i < 0) return;
        const line = buf.subarray(0, i).toString('utf8');
        buf = buf.subarray(i + 2);
        onLine(line);
        if (sock !== socket && buf.length === 0) return;
      }
    };
    socket.on('error', () => undefined);
    socket.on('data', onData);
    send(b.greeting ?? '220 sink.test ESMTP');
  }
}
