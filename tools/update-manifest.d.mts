export function writeUpdateManifest(directory: string, version: string): Promise<{schemaVersion:number;version:string;files:Array<{path:string;sha256:string}>}>;
