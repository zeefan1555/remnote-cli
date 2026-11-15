declare module 'fs-native-extensions' {
  /** Nonblocking exclusive descriptor lock. Unsupported operations throw. */
  export function tryLock(fd: number): boolean;
}
