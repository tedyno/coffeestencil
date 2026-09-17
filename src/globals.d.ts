declare module 'clipper-lib';

// text import of the prebundled worker (bun: with { type: 'text' })
declare module '*.gen.js' {
  const source: string;
  export default source;
}

