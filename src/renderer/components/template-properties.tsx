import React, { useState } from 'react';
import { useApp } from '../store/app';
import { Button, TextInput } from './ui';

export function TemplateProperties({templateId,name}:{templateId:string;name:string}) {
  const command=useApp(s=>s.command);const toast=useApp(s=>s.toast);
  const [draft,setDraft]=useState(name);const [saving,setSaving]=useState(false);
  const save=async()=>{setSaving(true);try {if(!(await command({type:'template.rename',templateId,name:draft.trim()})).ok)return;if((await command({type:'template.save',templateId})).ok)toast({kind:'success',title:'模板名称已保存'});}finally{setSaving(false)}};
  return <form onSubmit={event=>{event.preventDefault();void save();}} className="mb-5 flex max-w-xl flex-wrap items-end gap-3">
    <label className="min-w-0 flex-1"><span className="mb-1.5 block text-xs text-ink2">模板名称</span><TextInput value={draft} maxLength={200} onChange={e=>setDraft(e.target.value)} disabled={saving}/></label>
    <Button type="submit" disabled={saving||!draft.trim()||draft.trim()===name}>保存模板名称</Button>
  </form>;
}
