export const PROTOCOL_VERSION: number;
export const MAX_READ: number;
export interface Identity { privateKey: CryptoKey; publicRaw: Uint8Array }
export function generateIdentity(extractable?: boolean): Promise<Identity>;
export function idOf(publicRaw: Uint8Array): Promise<string>;
export function b64u(bytes: Uint8Array): string;
export function unb64u(text: string): Uint8Array;
export function parseOffer(text: string): { hosts: string[]; port: number; hostPub: Uint8Array; secret: Uint8Array; name: string };
export class ProtocolError extends Error {}
