import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
export async function writeUpdateManifest(directory, version) {
  const files=[];
  const walk=async(relative='')=>{
    for(const item of await fs.readdir(path.join(directory,relative),{withFileTypes:true})) {
      const name=relative?`${relative}/${item.name}`:item.name;
      if(item.isSymbolicLink()) throw new Error(`Program manifest cannot contain symlinks: ${name}`);
      if(!relative && ['data','cache','logs','temp'].includes(item.name.toLowerCase())) continue;
      if(item.isDirectory()) await walk(name);
      else if(item.isFile() && name!=='resources/app-files.json') {
        const hash=createHash('sha256'); for await(const chunk of createReadStream(path.join(directory,name))) hash.update(chunk);
        files.push({path:name,sha256:hash.digest('hex')});
      }
    }
  };
  await walk(); files.sort((a,b)=>a.path.localeCompare(b.path));
  const manifest={schemaVersion:1,version,files};
  await fs.writeFile(path.join(directory,'resources','app-files.json'),JSON.stringify(manifest,null,2));
  return manifest;
}
