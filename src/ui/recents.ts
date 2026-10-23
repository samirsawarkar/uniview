export interface Recent {
  name: string;
  path?: string;
  size: number;
  openedAt: number;
}

const KEY = "uniview.recents.v1";
const MAX = 50;

function read(): Recent[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((r): r is Recent => typeof r?.name === "string") : [];
  } catch {
    return [];
  }
}

function write(list: Recent[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable (private mode): recents simply are not remembered */
  }
}

export function loadRecents(): Recent[] {
  return read().sort((a, b) => b.openedAt - a.openedAt);
}

const same = (a: Pick<Recent, "name" | "path">, b: Pick<Recent, "name" | "path">) =>
  a.path ? a.path === b.path : !b.path && a.name === b.name;

export function rememberRecent(entry: Omit<Recent, "openedAt">): Recent[] {
  const list = [{ ...entry, openedAt: Date.now() }, ...read().filter((r) => !same(r, entry))].slice(0, MAX);
  write(list);
  return list;
}

export function forgetRecent(entry: Recent): Recent[] {
  const list = read().filter((r) => !same(r, entry));
  write(list);
  return list.sort((a, b) => b.openedAt - a.openedAt);
}
