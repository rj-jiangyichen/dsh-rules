import { posix, win32 } from 'node:path';

// Paths belong to the executor, which may be POSIX while the control host is Windows.
export const pathApi = value => /^[A-Za-z]:[\\/]|^\\\\/.test(value) ? win32 : posix;
export const join = (first, ...rest) => pathApi(first).join(first, ...rest);
export const dirname = value => pathApi(value).dirname(value);
export const resolve = (...parts) => pathApi(parts.find(value => /^[A-Za-z]:[\\/]|^\\\\|^\//.test(value)) ?? process.cwd()).resolve(...parts);
export const relative = (from, to) => pathApi(from).relative(from, to).replaceAll('\\', '/');
export const isAbsolute = value => posix.isAbsolute(value) || win32.isAbsolute(value);
