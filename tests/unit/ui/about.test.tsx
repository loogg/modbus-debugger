import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AboutScreen } from '../../../src/renderer/screens/about';
import { useApp } from '../../../src/renderer/store/app';
import { emptyWorkspace } from '../../../src/domain/model';
import { DEFAULT_PREFS } from '../../../src/main/services/workspace';
import type { Command } from '../../../src/shared/commands';
import type { UpdateState } from '../../../src/shared/update';
const initial = ():UpdateState => ({currentVersion:'0.10.0',packageKind:'zip',platform:'win32',arch:'x64',phase:'idle',latest:null,available:false,checkedAt:null,receivedBytes:0,totalBytes:0,downloadPath:null,error:null});
const command=vi.fn((_cmd:Command)=>undefined);
beforeEach(()=>{ command.mockClear(); useApp.setState({command:async <T,>(cmd:Command)=>{command(cmd); return {ok:true,value:null as T};}, snapshot:{revision:1,workspace:emptyWorkspace(),workspacePath:null,dirty:false,connections:{},blocks:{},points:{},transactions:[],parseEvents:[],diagRev:0,health:{},recording:null,sessions:[],warnings:[],prefs:DEFAULT_PREFS,historyDbPath:'',update:initial()}}); });
afterEach(cleanup);
const publish = (patch:Partial<UpdateState>)=>act(()=>useApp.getState().applyDelta({revision:2,transactions:[],update:{...initial(),...patch}}));
it('shows the current application version and sends only typed check/link commands',()=>{
  render(<AboutScreen />); expect(screen.getByText('v0.10.0')).toBeTruthy(); expect(command).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'检查更新'})); expect(command).toHaveBeenCalledWith({type:'update.check'});
  fireEvent.click(screen.getByRole('button',{name:'GitHub'})); expect(command).toHaveBeenCalledWith({type:'update.openLink',target:'repository'});
});
it('displays backend progress delivered with transactions and permits cancellation without duplicate download',()=>{
  render(<AboutScreen />); publish({phase:'downloading',receivedBytes:50,totalBytes:100});
  expect(screen.getByRole('progressbar').getAttribute('value')).toBe('50'); expect(screen.getByRole('button',{name:'下载中…'})).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'取消'})); expect(command).toHaveBeenCalledWith({type:'update.cancel'});
});
it('renders errors and treats release text as plain text',()=>{
  render(<AboutScreen />); publish({phase:'error',error:'网络失败',latest:{version:'1.0.0',url:'https://github.com/loogg/modbus-debugger/releases/tag/v1.0.0',notes:'<script>bad()</script>',publishedAt:null,asset:null}});
  expect(screen.getByRole('alert')).toHaveTextContent('更新操作未完成'); expect(screen.getByText('网络失败')).toBeTruthy(); expect(document.querySelector('script')).toBeNull();
});
it('exposes the verified download location and format-specific upgrade guidance',()=>{
  render(<AboutScreen />); publish({phase:'downloaded',packageKind:'portable',downloadPath:'D:/tool/data/updates/new-Portable.exe'});
  expect(screen.getByText(/替换外层 Portable/)).toBeTruthy(); fireEvent.click(screen.getByRole('button',{name:'打开下载目录'})); expect(command).toHaveBeenCalledWith({type:'update.reveal'});
});
it('requires an explicit install confirmation and permits cancelling it',()=>{
  render(<AboutScreen />);publish({phase:'downloaded',canInstall:true});
  fireEvent.click(screen.getByRole('button',{name:'安装更新并重启'}));expect(command).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'取消'}));expect(screen.queryByRole('alertdialog')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'安装更新并重启'}));fireEvent.click(screen.getByRole('button',{name:'确认安装并重启'}));expect(command).toHaveBeenCalledWith({type:'update.install'});
});
