declare module 'electron-squirrel-startup' {
  const handlingSquirrelEvent: boolean;
  export default handlingSquirrelEvent;
}

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;

declare module '*?url' {
  const src: string;
  export default src;
}