// Ziele von Benachrichtigungen und Hinweisen: nur eigene relative Pfade. Dieselbe Regel prüft der Browser noch einmal
// (zusätzlich mit derselben Herkunft), bevor er einem Ziel folgt.
import { strlen } from '../php.js';

const SAFE_LINK = /^\/(?!\/)[A-Za-z0-9/_.~%#?=&-]*$/;

// '' für alles, was kein eigener Pfad ist: //host, https://…, javascript:, /\host, Steuerzeichen, über 255 Bytes.
// Im Pfad (vor ? und #) zusätzlich weder // noch Punkt-Segmente (auch als %2e) – der Browser würde sie auflösen und
// könnte so bei einer fremden Adresse landen (/.//evil.example wird zu //evil.example).
export function safeLink(link: unknown): string {
  if (typeof link !== 'string' || strlen(link) > 255 || !SAFE_LINK.test(link)) return '';
  const path = link.split(/[?#]/, 1)[0];
  if (path.includes('//') || /\/(?:\.|%2e){1,2}(?=\/|$)/i.test(path)) return '';
  return link;
}
