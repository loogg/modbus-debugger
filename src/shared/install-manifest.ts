import { z } from 'zod';
export const programManifestSchema=z.object({
  schemaVersion:z.literal(1), version:z.string().min(1).max(100),
  files:z.array(z.object({path:z.string().min(1).max(240),sha256:z.string().regex(/^[a-f0-9]{64}$/i)})).min(1).max(20000),
}).superRefine((manifest,ctx)=>{
  const names=new Set<string>();
  for(const entry of manifest.files) {
    const parts=entry.path.split('/'); const lower=entry.path.toLowerCase();
    if(entry.path.includes('\\') || parts.some(p=>!p || p==='.' || p==='..' || /[<>:"|?*]/.test(p) || [...p].some(c=>c.charCodeAt(0)<32) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)) || ['data','cache','logs','temp'].includes(parts[0]!.toLowerCase()) || lower==='resources/app-files.json' || names.has(lower)) ctx.addIssue({code:z.ZodIssueCode.custom,message:`Unsafe or duplicate program path: ${entry.path}`});
    names.add(lower);
  }
  if(!names.has('modbus-debugger.exe') || !names.has('resources/app.asar')) ctx.addIssue({code:z.ZodIssueCode.custom,message:'Program manifest is incomplete'});
});
export type ProgramManifest=z.infer<typeof programManifestSchema>;
