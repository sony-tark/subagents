const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const esbuild = require(process.env.PI_SUBAGENT_ESBUILD || path.join(os.homedir(), '.pi/agent/install/releases/1.0.2/node_modules/esbuild'));

const root = path.resolve(__dirname, '..');
async function load(entry, mocks) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-subagent-test-'));
  const outfile = path.join(dir, 'extension.cjs');
  try {
    await esbuild.build({
      entryPoints: [path.join(root, entry)], outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
      plugins: [{ name: 'pi-test-doubles', setup(build) {
        build.onResolve({ filter: /.*/ }, args => {
          const key = args.path.startsWith('.') ? path.basename(args.path) : args.path;
          if (Object.hasOwn(mocks, key)) return { path: key, namespace: 'pi-test-double' };
        });
        build.onLoad({ filter: /.*/, namespace: 'pi-test-double' }, args => ({ contents: mocks[args.path], loader: 'js' }));
      } }],
    });
    return require(outfile);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const fakeType = `exports.Type = new Proxy({}, {get: () => (...args) => args});`;
const fakeTui = `exports.Text = class { constructor(text) { this.text = text; } }; exports.matchesKey = (key, expected) => key === expected; exports.truncateToWidth = (text, width) => text.slice(0, width); exports.visibleWidth = text => text.length; exports.wrapTextWithAnsi = (text, width) => [text.slice(0, width), ...text.length > width ? [text.slice(width, width * 2)] : []];`;

function record(status = 'completed') {
  return { id: 'child-12345678', runId: 'run-1', parentSessionId: 'root', anchor: null, depth: 1,
    definition: { name: 'explore', tools: ['read'], source: 'built-in' }, task: 'Explore',
    status, startedAt:Date.now(), toolCount: 3, result: 'Done', usage: { totalTokens: 200, cost: { total: 1.25 } },
    background: false };
}
async function uiFixture(children, previousEditorFactory) {
  const state = { children, editorFactory:previousEditorFactory, widgets: [], widgetNames: [], commands: {}, tools: {}, handlers: {}, accounts: [], custom: null, customOptions: null, renders: 0, terminalRows: 30,
    transcript: Array.from({length:80}, (_,i) => 'line '+i) };
  globalThis.__piSubagentTest = state;
  const mocks = {
    '@earendil-works/pi-ai': fakeType,
    '@earendil-works/pi-coding-agent': `exports.CustomEditor = class { constructor() { this.text=''; this.forwarded=[]; } getText() {return this.text;} setText(text) {this.text=text;} handleInput(key) {this.forwarded.push(key);} };`,
    '@earendil-works/pi-tui': fakeTui,
    'definitions.ts': `exports.builtins = [{name:'explore', tools:['read'], source:'built-in'}]; exports.discover = () => ({definitions:exports.builtins, errors:[]});`,
    'manager.ts': `class ChildManager { constructor() { globalThis.__piSubagentTest.manager=this; this.rootSessionId='root'; this.onChange=()=>{}; this.onNotice=()=>{}; } list() {return globalThis.__piSubagentTest.children;} currentUsage(c) {return c.usage;} get(id) {return this.list().find(c => c.id === id);} dismiss(id) {this.get(id).dismissed=true; this.onChange();} transcript() {return globalThis.__piSubagentTest.transcript.join('\\n');} account(child, store) {globalThis.__piSubagentTest.accounts.push([child,store]);} async spawn() {return globalThis.__piSubagentTest.children[0];} async shutdown() {} publish() {} deliverNested() {} } exports.ChildManager=ChildManager;`,
  };
  const pi = {
    on: (name, cb) => { state.handlers[name] = cb; }, registerTool: tool => { state.tools[tool.name] = tool; },
    registerCommand: (name, command) => { state.commands[name] = command; },
    registerMessageRenderer() {}, registerShortcut() {}, sendMessage() {},
  };
  const extension = await load('index.ts', mocks);
  extension.default(pi);
  const ui = {
    setWidget: (name, widget) => {state.widgetNames.push(name);state.widgets.push(widget);state.renders++;}, setEditorComponent: factory => {state.editorFactory=factory;}, getEditorComponent: () => state.editorFactory, notify() {},
    custom: (factory, options) => new Promise(resolve => { state.customOptions = options; state.custom = factory({ terminal:{ get rows() {return state.terminalRows;} }, requestRender() {state.renders++;} }, { fg: (_color, value) => value, bg: (_color, value) => value }, {}, resolve); }),
  };
  const store = { getSessionId: () => 'root', getBranch: () => [], getLeafId: () => null,
    getSessionFile: () => '/tmp/root-session.jsonl', buildSessionContext: () => ({ messages: [] }), appendUsage() {} };
  const ctx = { mode:'tui', ui, cwd: '/tmp', model: { provider:'test', id:'test' }, hasUI:true,
    thinkingLevel:'off', sessionManager:store, isProjectTrusted:() => true, getSystemPrompt:() => 'root' };
  state.handlers.session_start({}, ctx);
  return { state, ctx, store };
}

function editorAndWidget(state) {
  assert.equal(typeof state.editorFactory, 'function', 'the regular composer must own inline selector keys');
  const tui = { terminal:{get rows() {return state.terminalRows;}}, requestRender() {state.renders++;} };
  const theme = {fg:(_color,s)=>s,bg:(_color,s)=>s};
  const editor=state.editorFactory(tui,theme,{});
  const render=(width=80) => { const factory=state.widgets.at(-1); return factory ? factory(tui,theme).render(width).join('\n') : ''; };
  return {editor,render};
}

test('inline widget uses the subagents name', async () => {
  const {state}=await uiFixture([record('running')]);
  assert.deepEqual([...new Set(state.widgetNames)], ['subagents']);
});

test('Down enters inline main-agent selector, then selects children; Up exits into composer', async () => {
  const child = record('running'); child.name='active-child';
  const {state,ctx}=await uiFixture([child]);
  const {editor,render}=editorAndWidget(state);
  assert.equal(state.custom,null, 'navigation must not open an overlay');
  editor.handleInput('down');
  assert.match(render(),/❯.*Main agent/);
  editor.handleInput('down');
  assert.match(render(),/❯.*active-child/);
  editor.handleInput('up');
  assert.match(render(),/❯.*Main agent/);
  editor.handleInput('up');
  assert.doesNotMatch(render(),/❯.*Main agent/);
  editor.handleInput('up');
  assert.ok(editor.forwarded.includes('up'), 'normal editor receives Up after leaving the selector');
  editor.setText('draft prompt');
  editor.handleInput('down');
  assert.equal(editor.forwarded.at(-1),'down', 'editing a prompt preserves cursor and history behavior');
  assert.doesNotMatch(render(),/❯/);
  assert.equal(ctx.sessionManager.getSessionId(),'root');
});

test('autocomplete keys stay with the editor and session shutdown restores its factory', async () => {
  const {state}=await uiFixture([record('running')]);
  const {editor,render}=editorAndWidget(state);
  editor.isShowingAutocomplete=()=>true;
  editor.handleInput('down');
  assert.equal(editor.forwarded.at(-1),'down');
  assert.doesNotMatch(render(),/❯/);
  await state.handlers.session_shutdown();
  assert.equal(state.editorFactory,undefined);
});

test('inline navigation wraps and restores a previously installed editor', async () => {
  const baseFactory=()=>({text:'',forwarded:[],getText() {return this.text;},setText(text) {this.text=text;},handleInput(key) {this.forwarded.push(key);}});
  const {state}=await uiFixture([record('running')],baseFactory);
  const {editor,render}=editorAndWidget(state);
  editor.handleInput('down');
  assert.match(render(),/Main agent/);
  editor.handleInput('up'); editor.handleInput('up');
  assert.deepEqual(editor.forwarded,['up']);
  await state.handlers.session_shutdown();
  assert.equal(state.editorFactory,baseFactory);
});

test('inline child transcript scrolls without a popup using Shift+Up/Down', async () => {
  const {state}=await uiFixture([record('running')]);
  const {editor,render}=editorAndWidget(state);
  editor.handleInput('down'); editor.handleInput('down');
  assert.match(render(),/line 79/);
  editor.handleInput('shift+up');
  assert.doesNotMatch(render(),/line 79/, 'scroll up must move off the newest line');
  assert.match(render(),/line 7[0-8]/);
  editor.handleInput('shift+down');
  assert.match(render(),/line 79/, 'scrolling back down resumes the latest output');
});

test('finished children leave the passive panel but remain in inline history', async () => {
  const {state,ctx}=await uiFixture([record()]);
  assert.equal(state.widgets.at(-1),undefined);
  await state.commands.subagents.handler('tasks',ctx);
  const {render}=editorAndWidget(state);
  assert.match(render(),/❯.*Main agent/);
  assert.match(render(),/explore/);
  assert.equal(state.custom,null);
});

test('a finished child disappears from the passive panel without losing inline history', async () => {
  const child=record('running');
  const {state}=await uiFixture([child]);
  assert.equal(typeof state.widgets.at(-1),'function');
  child.status='completed'; state.manager.onChange();
  assert.equal(state.widgets.at(-1),undefined);
  const {editor,render}=editorAndWidget(state);
  editor.handleInput('down'); editor.handleInput('down');
  assert.match(render(),/completed/);
});

test('dismiss removes an inline row but h can reveal saved history', async () => {
  const {state}=await uiFixture([record()]);
  const {editor,render}=editorAndWidget(state);
  editor.handleInput('down'); editor.handleInput('down'); editor.handleInput('x');
  await new Promise(resolve => setImmediate(resolve));
  assert.doesNotMatch(render(),/explore/);
  editor.handleInput('h');
  assert.match(render(),/explore/);
});

test('empty inline selector returns to the composer with Up', async () => {
  const {state}=await uiFixture([]);
  const {editor,render}=editorAndWidget(state);
  editor.handleInput('down');
  assert.match(render(),/❯.*Main agent/);
  editor.handleInput('down');
  assert.match(render(),/❯.*Main agent/);
  editor.handleInput('up');
  assert.equal(render(),'');
});

test('inline selector puts running children first and expands the selected task', async () => {
  const finished=record(); finished.id='finished-child'; finished.name='finished-child'; finished.startedAt=Date.now();
  const running=record('running'); running.id='active-child'; running.name='active-child'; running.startedAt=Date.now()-1000;
  running.task='Inspect runtime policies and summarize relevant safety boundaries';
  const {state}=await uiFixture([finished,running]);
  const {editor,render}=editorAndWidget(state);
  editor.handleInput('down'); editor.handleInput('down');
  let lines=render();
  assert.ok(lines.indexOf('active-child') < lines.indexOf('finished-child'));
  assert.match(lines,/❯.*active-child/);
  assert.doesNotMatch(lines,/summarize relevant safety boundaries/);
  editor.handleInput('enter');
  assert.match(render(),/summarize relevant safety boundaries/);
  editor.handleInput('down');
  assert.match(render(),/❯.*finished-child/);
  editor.handleInput('up');
  assert.match(render(),/❯.*active-child/);
});

test('partial inline preview shows the report instead of just a turn-limit banner', async () => {
  const child=record('partial');
  child.result='[Turn limit 4 reached; resume for more work.]\nNo final narrative was produced. Work so far: 3 tools.';
  const {state}=await uiFixture([child]);
  const {editor,render}=editorAndWidget(state);
  editor.handleInput('down'); editor.handleInput('down'); editor.handleInput('enter');
  assert.match(render(),/No final narrative/);
  assert.match(render(),/line 79/);
});

test('narrow inline selector keeps the live transcript and exit hint on screen', async () => {
  const {state}=await uiFixture([record('running')]); state.terminalRows=12;
  const {editor,render}=editorAndWidget(state);
  editor.handleInput('down'); editor.handleInput('down');
  const lines=render(32).split('\n');
  assert.ok(lines.length <= state.terminalRows);
  assert.match(lines.join('\n'),/line 79/);
  assert.match(lines.join('\n'),/composer/);
  assert.ok(lines.every(line=>line.length<=32));
});

test('inline cost and foreground tool results show the child usage', async () => {
  const {state}=await uiFixture([record()]);
  const {editor,render}=editorAndWidget(state);
  editor.handleInput('down'); editor.handleInput('down');
  assert.match(render(),/\$1\.25/);
  const result=state.tools.delegate_agent.renderResult({details:{childId:'child-12345678',status:'completed',usage:record().usage},content:[],isError:false},{expanded:false},{fg:(_color,s)=>s});
  assert.match(result.text,/\$1\.25/);
});

test('human foreground command attributes child usage to root session', async () => {
  const { state, ctx, store } = await uiFixture([record()]);
  await state.commands.subagents.handler('run explore Explore', ctx);
  assert.deepEqual(state.accounts, [[state.children[0], store]]);
});

test('inline transcript g/G and live updates follow the newest output', async () => {
  const {state}=await uiFixture([record('running')]);
  const {editor,render}=editorAndWidget(state);
  editor.handleInput('down'); editor.handleInput('down');
  assert.match(render(),/line 79/);
  editor.handleInput('g');
  assert.match(render(),/line 0/);
  editor.handleInput('G');
  state.transcript.push('line 80'); state.manager.onChange();
  assert.ok(state.renders>0);
  assert.match(render(),/line 80/);
});

test('open ID selects an inline child without switching Pi sessions', async () => {
  const first=record('running'); first.id='first-agent'; first.name='first-agent'; first.startedAt=Date.now()-2000;
  const second=record('running'); second.id='second-agent'; second.name='second-agent'; second.startedAt=Date.now()-1000;
  const {state,ctx}=await uiFixture([first,second]);
  await state.commands.subagents.handler('open second-agent',ctx);
  const {editor,render}=editorAndWidget(state);
  assert.match(render(),/❯.*second-agent/);
  editor.handleInput('down');
  assert.match(render(),/❯.*first-agent/);
  editor.handleInput('up');
  assert.match(render(),/❯.*second-agent/);
  assert.equal(ctx.sessionManager.getSessionId(),'root');
  assert.equal(state.custom,null);
});

test('live child view includes the tool call, not only its result', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-subagent-transcript-test-'));
  try {
    const { ChildManager } = await load('manager.ts', {
      '@earendil-works/pi-ai': fakeType,
      '@earendil-works/pi-coding-agent': `exports.getAgentDir=()=>${JSON.stringify(dir)}; exports.SessionManager={};`,
      'definitions.ts': `exports.discover=()=>({definitions:[],errors:[]});`,
      'runtime.ts': `exports.childResources=async()=>({});`,
    });
    const m = new ChildManager('root', dir);
    const c = record('running'); c.file = path.join(dir, 'child.jsonl');
    fs.writeFileSync(c.file, 'fixture'); m.records.set(c.id, c);
    m.live.set(c.id, { session: { sessionManager: { getBranch: () => [{ type:'message', message: { role:'assistant', content:[
      {type:'text', text:'Checking the file'}, {type:'toolCall', name:'agent_read', arguments:{path:'index.ts'}}] } }] } } });
    assert.match(m.transcript(c.id), /tool agent_read: .*index\.ts/);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('human command child usage appears once in the real Pi parent session cost', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-subagent-cost-test-'));
  try {
    const sdkFile = process.env.PI_SUBAGENT_SDK || path.join(os.homedir(), '.pi/agent/install/releases/1.0.2/node_modules/@earendil-works/pi-coding-agent/dist/index.js');
    const { SessionManager, createAgentSession } = await import(pathToFileURL(sdkFile).href);
    const { ChildManager } = await load('manager.ts', {
      '@earendil-works/pi-ai': fakeType,
      '@earendil-works/pi-coding-agent': `exports.getAgentDir=()=>${JSON.stringify(dir)}; exports.SessionManager={};`,
      'definitions.ts': `exports.discover=()=>({definitions:[],errors:[]});`,
      'runtime.ts': `exports.childResources=async()=>({});`,
    });
    const m = new ChildManager('root', dir);
    const c = record(); c.modelProvider = 'test-provider'; c.modelId = 'test-model';
    c.usage = {input:2,output:3,cacheRead:0,cacheWrite:0,totalTokens:5,cost:{input:0.5,output:0.75,cacheRead:0,cacheWrite:0,total:1.25}};
    const parent = SessionManager.inMemory();
    m.account(c, parent, true); m.account(c, parent, true);
    const background = {...c, id:'background-child', runId:'background-run', background:true,
      usage:{...c.usage, cost:{input:0.1,output:0.15,cacheRead:0,cacheWrite:0,total:0.25}}};
    m.account(background, parent); m.account(background, parent);
    const { session } = await createAgentSession({ sessionManager: parent, noTools: true });
    try { assert.equal(session.getSessionStats().cost, 1.5); }
    finally { session.dispose(); }
    assert.equal(parent.getBranch().filter(e => e.type === 'usage').length, 2);
  } finally { fs.rmSync(dir, {recursive:true, force:true}); }
});

test('a nested child can cold-resume while its owning parent is active', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-subagent-nested-test-'));
  try {
    const saved = path.join(dir, 'child.jsonl'); fs.writeFileSync(saved, 'fixture');
    const branch = [{id:'parent-anchor'}];
    const store = { getSessionId:() => 'parent-session', getBranch:() => branch, getLeafId:() => 'parent-anchor' };
    let childEvent;
    const activated = [];
    const childSession = { sessionManager:store, getActiveToolNames:()=>[], setActiveToolsByName:names=>activated.push(names), subscribe:handler=>{childEvent=handler;return()=>{};}, dispose:()=>{} };
    const { ChildManager } = await load('manager.ts', {
      '@earendil-works/pi-ai': fakeType,
      '@earendil-works/pi-coding-agent': `exports.getAgentDir=()=>${JSON.stringify(dir)}; exports.SessionManager={open:()=>globalThis.__nestedStore}; exports.createAgentSession=async()=>({session:globalThis.__nestedSession}); for (const name of ['Read','Grep','Find','Ls','Bash','Edit','Write']) exports['create'+name+'Tool']=()=>({description:'test',parameters:{},execute:()=>{}});`,
      'definitions.ts': `exports.discover=()=>({definitions:[{name:'explore',source:'built-in',tools:['read'],prompt:'Explore'}],errors:[]});`,
      'runtime.ts': `exports.childResources=async()=>({resourceLoader:{},settingsManager:{}});`,
    });
    globalThis.__nestedStore = store; globalThis.__nestedSession = childSession;
    const m = new ChildManager('root', dir);
    const parent = record('running'); parent.id='parent-id'; parent.definition.source='built-in';
    parent.definition.name='explore'; parent.parentSessionId='root'; parent.anchor=null;
    const child = record(); child.id='nested-id'; child.parentId=parent.id; child.parentSessionId='parent-session'; child.anchor='parent-anchor';
    child.depth=2; child.file=saved; child.definition={...child.definition, source:'inherited', name:'general-purpose'};
    m.records.set(parent.id,parent); m.records.set(child.id,child);
    m.live.set(parent.id,{session:{sessionManager:store}});
    const ctx = {sessionManager:{getSessionId:()=> 'root',getBranch:()=>[]},isProjectTrusted:()=>true};
    assert.equal((await m.open(child, ctx)).session, childSession);
    assert.ok(activated[0].includes('agent_read'), 'cold resume restores approved tools after a summary-only turn');
    let refreshes = 0; m.onChange = () => refreshes++;
    childEvent({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'Still examining the file'}});
    assert.match(m.transcript(child.id), /assistant \(streaming\): Still examining the file/);
    await new Promise(resolve => setTimeout(resolve, 125));
    assert.ok(refreshes > 0, 'model text deltas should update the child view');
  } finally { delete globalThis.__nestedStore; delete globalThis.__nestedSession; fs.rmSync(dir,{recursive:true,force:true}); }
});

test('turn cap reserves the last turn for a tool-free summary without exceeding maxTurns', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-subagent-limit-test-'));
  try {
    const { ChildManager } = await load('manager.ts', {
      '@earendil-works/pi-ai': fakeType,
      '@earendil-works/pi-coding-agent': `exports.getAgentDir=()=>${JSON.stringify(dir)}; exports.SessionManager={};`,
      'definitions.ts': `exports.discover=()=>({definitions:[],errors:[]});`,
      'runtime.ts': `exports.childResources=async()=>({});`,
    });
    const m = new ChildManager('root', dir);
    const child = record('running'); child.maxTurns = 4;
    const loadouts = [], reminders = [];
    const session = {agent:{finishTurn:async()=>undefined},getActiveToolNames:()=>['agent_read'],
      setActiveToolsByName: names => loadouts.push(names),sendCustomMessage:async (msg, options) => {reminders.push([msg,options]);}};
    const live = {session,turns:2,turnLimitReached:false,abortRequested:false};
    m.installTurnLimit(child, live);
    const turn = { message:{role:'assistant',stopReason:'toolUse',content:[{type:'toolCall',name:'agent_read'}]},toolResults:[{role:'toolResult'}] };
    await session.agent.finishTurn(turn);
    assert.deepEqual(loadouts, [[]], 'tools must be disabled before the final assistant request');
    assert.match(reminders[0]?.[0]?.content || '', /summar/i);
    assert.equal(live.turns,3);
    await session.agent.finishTurn({message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'Partial findings...'}]},toolResults:[]});
    assert.equal(live.turns,4);
    assert.equal(live.turnLimitReached,true);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('real Pi SDK receives the last-turn summary reminder with tools removed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-subagent-sdk-limit-test-'));
  let session;
  try {
    const sdkFile = process.env.PI_SUBAGENT_SDK || path.join(os.homedir(), '.pi/agent/install/releases/1.0.2/node_modules/@earendil-works/pi-coding-agent/dist/index.js');
    const aiFile = path.join(path.dirname(path.dirname(path.dirname(sdkFile))), 'pi-ai/dist/index.js');
    const { SessionManager, createAgentSession } = await import(pathToFileURL(sdkFile).href);
    const { createAssistantMessageEventStream } = await import(pathToFileURL(aiFile).href);
    const model = { id:'fake-offline-model',name:'Fake offline model',api:'openai-completions',provider:'test',baseUrl:'https://example.invalid',
      input:['text'],reasoning:false,contextWindow:32000,maxTokens:1000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0} };
    ({session} = await createAgentSession({cwd:dir,agentDir:dir,model,sessionManager:SessionManager.inMemory(dir),
      tools:['agent_read'],customTools:[{name:'agent_read',label:'Read fixture',description:'Read fixture',
        parameters:{type:'object',properties:{}},execute:async()=>({content:[{type:'text',text:'Evidence: fixture present'}]})}]}));
    let calls=0;
    session.agent.streamFunction = (_model, context) => {
      calls++;
      if (calls === 2) {
        assert.deepEqual(session.getActiveToolNames(), [], 'the final provider request should have no callable tools');
        assert.match(JSON.stringify(context.messages), /One assistant turn remains/);
      }
      const reason = calls === 1 ? 'toolUse' : 'stop';
      const message = {role:'assistant', api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),stopReason:reason,
        usage:{input:2,output:2,cacheRead:0,cacheWrite:0,totalTokens:4,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},
        content:calls === 1 ? [{type:'toolCall',id:'call-1',name:'agent_read',arguments:{}}] : [{type:'text',text:'Verified fixture; more review needed.'}]};
      const stream=createAssistantMessageEventStream();
      stream.push({type:'start',partial:message}); stream.push({type:'done',reason,message});
      return stream;
    };
    session._modelRuntime.hasConfiguredAuth=()=>true; // Offline fake stream; no provider request is made.
    const { ChildManager } = await load('manager.ts', {
      '@earendil-works/pi-ai': fakeType,
      '@earendil-works/pi-coding-agent': `exports.getAgentDir=()=>${JSON.stringify(dir)}; exports.SessionManager={};`,
      'definitions.ts': `exports.discover=()=>({definitions:[],errors:[]});`,
      'runtime.ts': `exports.childResources=async()=>({});`,
    });
    const m=new ChildManager('root',dir); const child=record('running'); child.maxTurns=2;
    const live={session,turns:0,turnLimitReached:false,abortRequested:false};
    m.records.set(child.id,child); m.live.set(child.id,live);
    m.installTurnLimit(child,live);
    const unsubscribe=session.subscribe(event => { if (event.type==='agent_end') m.guardTurnLimitAtEnd(child,live); });
    await session.prompt('Inspect the fixture', {expandPromptTemplates:false,source:'extension'});
    unsubscribe();
    assert.equal(calls,2);
    assert.equal(live.turnLimitReached,true, JSON.stringify({turns:live.turns,summaryRequested:live.summaryRequested,last:session.messages.at(-1)?.stopReason,error:session.messages.at(-1)?.errorMessage}));
    assert.match(session.getLastAssistantText(),/Verified fixture/);
    m.settle(child);
    assert.equal(child.status,'partial');
    assert.match(child.result,/Verified fixture/);
  } finally { session?.dispose(); fs.rmSync(dir,{recursive:true,force:true}); }
});

test('turn-cap partial result explains progress when no final narrative was produced', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-subagent-partial-test-'));
  try {
    const { ChildManager } = await load('manager.ts', {
      '@earendil-works/pi-ai': fakeType,
      '@earendil-works/pi-coding-agent': `exports.getAgentDir=()=>${JSON.stringify(dir)}; exports.SessionManager={};`,
      'definitions.ts': `exports.discover=()=>({definitions:[],errors:[]});`,
      'runtime.ts': `exports.childResources=async()=>({});`,
    });
    const m = new ChildManager('root', dir);
    const child = record('running'); child.maxTurns=4; child.toolCount=3; child.lastTool='agent_read';
    m.records.set(child.id, child);
    m.live.set(child.id, {turns:4,turnLimitReached:true,abortRequested:false,session:{
      messages:[{role:'assistant',stopReason:'toolUse',content:[{type:'toolCall',name:'agent_read',arguments:{path:'manager.ts'}}]}],
      getLastAssistantText:()=>'',sessionManager:{getBranch:()=>[]},sessionFile:undefined,
    }});
    m.settle(child);
    assert.equal(child.status,'partial');
    assert.match(child.result, /3 tool/);
    assert.match(child.result, /agent_read/);
    assert.match(child.result, /no final (narrative|summary|report)/i);
    assert.match(child.result, /resume/i);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('capped runs report queued human follow-ups that were not delivered', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-subagent-queue-limit-test-'));
  try {
    const { ChildManager } = await load('manager.ts', {
      '@earendil-works/pi-ai': fakeType,
      '@earendil-works/pi-coding-agent': `exports.getAgentDir=()=>${JSON.stringify(dir)}; exports.SessionManager={};`,
      'definitions.ts': `exports.discover=()=>({definitions:[],errors:[]});`,
      'runtime.ts': `exports.childResources=async()=>({});`,
    });
    const m = new ChildManager('root', dir);
    const child = record('running'); child.maxTurns=4; m.records.set(child.id,child);
    const id='11111111-1111-1111-1111-111111111111';
    const session = { messages:[{role:'assistant',stopReason:'stop',content:[{type:'text',text:'Partial result'}]}],
      getLastAssistantText:()=> 'Partial result',sessionManager:{getBranch:()=>[]},agent:{hasQueuedMessages:()=>true},
      pendingMessageCount:1, clearQueue:()=>({steering:[],followUp:[`[Human follow-up ${id}] Check next file`]}),
      abort:async()=>{},sessionFile:undefined };
    const live = {turns:4,turnLimitReached:true,abortRequested:false,session}; m.live.set(child.id,live);
    m.guardTurnLimitAtEnd(child,live);
    m.settle(child);
    assert.deepEqual(child.deliveryUncertain,[id]);
    assert.match(child.result, /uncertain delivery/i);
    assert.match(child.result, /resend/i);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('finished child SDK sessions are disposed even without MCP or hook resources', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-subagent-manager-test-'));
  try {
    const mocks = {
      '@earendil-works/pi-ai': fakeType,
      '@earendil-works/pi-coding-agent': `exports.getAgentDir=()=>${JSON.stringify(dir)}; exports.SessionManager={};`,
      'definitions.ts': `exports.discover=()=>({definitions:[],errors:[]});`,
      'runtime.ts': `exports.childResources=async()=>({});`,
    };
    const { ChildManager } = await load('manager.ts', mocks);
    const manager = new ChildManager('root', dir);
    const child = record();
    child.status = 'running'; child.seedMessageCount = 0;
    child.file = path.join(dir, 'saved-child.jsonl'); fs.writeFileSync(child.file, 'fixture');
    manager.records.set(child.id, child);
    let disposed = false, unsubscribed = false;
    const live = { abortRequested:false, turns:0, turnLimitReached:false, unsubscribe:()=>{unsubscribed=true;},
      session: { messages:[{role:'assistant',stopReason:'stop',content:[{type:'text',text:'Done'}], usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}}],
        getLastAssistantText:()=> 'Done', sessionManager:{getBranch:()=>[]}, dispose:()=>{disposed=true;} },
    };
    manager.live.set(child.id, live);
    await manager.finalize(child);
    assert.equal(child.status,'completed');
    assert.equal(disposed,true);
    assert.equal(unsubscribed,true);
    assert.equal(manager.live.size,0);
    assert.equal(manager.records.get(child.id), child);
    assert.equal(fs.existsSync(child.file), true, 'cleanup must preserve the resumable transcript');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
