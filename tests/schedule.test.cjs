// Run: node tests/schedule.test.cjs (Playwright and Chromium required).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const html = fs.readFileSync(path.join(__dirname, '../index.html'));
(async () => {
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  let browser; let passed = 0;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
    const page = await browser.newPage({ acceptDownloads: true });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => d.accept());
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    async function check(name, fn) { await fn(); passed++; console.log('PASS', name); }
    async function scenario(appts, candidates = ['신현주'], options = {}) {
      return page.evaluate(({appts,candidates,options}) => {
        SCHED = { '정주은': appts };
        for (const name of candidates) SCHED[name] = options.schedules?.[name] || {};
        PT_NAMES = Object.keys(SCHED); ABS_SETTINGS = {}; globalResultData = null;
        document.getElementById('absConfigList').innerHTML = '';
        document.getElementById('stepTwo').style.display='block';
        createIndividualConfig('정주은');
        for (const [name, setting] of Object.entries(options.leaves || {})) {
          if (name !== '정주은') createIndividualConfig(name);
          ABS_SETTINGS[name].type = setting.type;
          if (setting.start) document.getElementById(`start-${name}`).value = setting.start;
          if (setting.dur) document.getElementById(`dur-${name}`).value = String(setting.dur);
        }
        runAssign(); return JSON.parse(JSON.stringify(globalResultData));
      }, {appts,candidates,options});
    }
    const appt = (c='IN105',p='가상환자') => ({p,c});
    await check('bundled XLSX works without external requests', async()=>assert.equal(await page.evaluate(()=>XLSX.version),'0.18.5'));
    await check('ordinary appointment actually assigned', async()=>assert.equal((await scenario({'9:00':appt()})).assigned[0].therapist,'신현주'));
    await check('exclude non-PT candidates', async()=>assert.equal((await scenario({'9:00':appt()},['이지현'])).assigned.length,0));
    await check('candidate working hours', async()=>assert.equal((await scenario({'8:00':appt()})).assigned.length,0));
    await check('existing reservation not overwritten', async()=>assert.equal((await scenario({'9:00':appt()},['신현주'],{schedules:{'신현주':{'9:00':appt('IN105','기존')}}})).assigned.length,0));
    await check('13-case tier ahead of 12-case tier', async()=>assert.equal((await scenario({'9:00':appt()},['이수현','신현주'])).assigned[0].therapist,'신현주'));
    await check('same tier prefers greater capacity', async()=>assert.equal((await scenario({'9:00':appt()},['신현주','조은서'],{schedules:{'신현주':{'14:00':appt()}}})).assigned[0].therapist,'조은서'));
    for(const code of ['IN048','IN302-1','EZ773']) await check(code+' converts to IN105',async()=>assert.equal((await scenario({'9:00':appt(code)})).assigned[0].code,'IN105'));
    for(const code of ['MM048','MX122-2','UNRECOGNIZED']) await check(code+' remains unassigned with reason',async()=>{const r=await scenario({'9:00':appt(code)});assert.equal(r.assigned.length,0);assert.ok(r.unassigned[0].reason);});
    await check('MM-EZ773-MM blocks middle treatment',async()=>{const r=await scenario({'9:00':appt('MM105'),'9:30':appt('EZ773'),'10:00':appt('MM105')});assert.ok(r.unassigned.some(a=>a.slot==='9:30'&&a.reason.includes('MM-EZ773-MM')));});
    await check('consecutive MM105 same patient rejected',async()=>assert.equal((await scenario({'9:30':appt('MM105')},['신현주'],{schedules:{'신현주':{'9:00':appt('MM105')}}})).assigned.length,0));
    await check('five consecutive slots allowed, sixth blocked',async()=>{
      const five={'9:00':appt(),'9:30':appt(),'10:00':appt(),'10:30':appt()};
      assert.equal((await scenario({'11:00':appt()},['신현주'],{schedules:{'신현주':five}})).assigned.length,1);
      assert.equal((await scenario({'11:30':appt()},['신현주'],{schedules:{'신현주':{...five,'11:00':appt()}}})).assigned.length,0);
    });
    await check('maximum case count respected',async()=>{const result=await page.evaluate(()=>{MAX_CNT['신현주']=0;return true;});assert.ok(result);assert.equal((await scenario({'9:00':appt()})).assigned.length,0);await page.evaluate(()=>delete MAX_CNT['신현주']);});
    await check('robot reserves both slots and counts as one case',async()=>{const r=await scenario({'9:00':appt('MM302-1')},['김수현']);assert.equal(r.assigned.length,1);assert.equal(r.extra['김수현']['9:30']._cont,true);assert.equal(await page.evaluate(r=>countSlots('김수현',r.extra['김수현']),r),1);});
    for(const slot of ['11:30','17:30']) await check('robot cannot cross boundary '+slot,async()=>assert.equal((await scenario({[slot]:appt('MM302-1')},['김수현','곽나현'])).assigned.length,0));
    await check('robot second slot cannot overwrite reservation',async()=>assert.equal((await scenario({'9:00':appt('MM302-1')},['김수현'],{schedules:{'김수현':{'9:30':appt()}}})).assigned.length,0));
    await check('respiratory qualification applied',async()=>assert.equal((await scenario({'9:00':appt('MM440')},['신현주','장희진'])).assigned[0].therapist,'장희진'));
    await check('generic care blocked in specialist session',async()=>assert.equal((await scenario({'9:00':appt()},['김수현'])).assigned.length,0));
    await check('hydrotherapy adjacent slot blocked',async()=>assert.equal((await scenario({'9:30':appt()},['윤대환'])).assigned.length,0));
    await check('partial leave only reassigns affected appointments',async()=>{const r=await scenario({'9:00':appt(),'14:00':appt()},['신현주'],{leaves:{'정주은':{type:'partial',start:'9:00',dur:2}}});assert.deepEqual(r.assigned.map(a=>a.slot),['9:00']);assert.equal(await page.locator('#resultArea tr').first().locator('.sc-ng').count(),0);});
    await check('partial-leave recipient available outside leave',async()=>{const r=await scenario({'9:00':appt()},['신현주'],{leaves:{'신현주':{type:'partial',start:'13:00',dur:2}}});assert.equal(r.assigned[0].therapist,'신현주');});
    await check('partial-leave recipient blocked during leave',async()=>assert.equal((await scenario({'13:00':appt()},['신현주'],{leaves:{'신현주':{type:'partial',start:'13:00',dur:2}}})).assigned.length,0));
    await check('robot overlapping only second half of leave is moved',async()=>assert.equal((await scenario({'9:00':appt('MM302-1')},['김수현'],{leaves:{'정주은':{type:'partial',start:'9:30',dur:2}}})).assigned.length,1));
    await check('lunch excluded from leave duration',async()=>{const r=await scenario({'11:30':appt(),'13:00':appt(),'14:00':appt(),'14:30':appt()},['신현주'],{leaves:{'정주은':{type:'partial',start:'11:30',dur:2}}});assert.deepEqual(r.assigned.map(a=>a.slot),['11:30','13:00','14:00']);});
    await check('robot ending at lunch keeps table columns aligned',async()=>{await scenario({'11:00':appt('MM302-1')},['김수현']);const widths=await page.locator('#resultArea tr').evaluateAll(rows=>rows.map(r=>Array.from(r.children).reduce((n,c)=>n+c.colSpan,0)));assert.ok(widths.length>1);assert.ok(widths.every(w=>w===widths[0]),JSON.stringify(widths));});
    await check('unassigned reason visible in page',async()=>{await scenario({'9:00':appt('MM048')});assert.match(await page.locator('#msgArea').innerText(),/MM048.*대체 불가/);});
    await check('changing leave invalidates export and results',async()=>{await scenario({'9:00':appt()});await page.locator('[id="type-정주은"]').selectOption('partial');assert.equal(await page.evaluate(()=>globalResultData),null);assert.equal(await page.locator('#expBtn').isDisabled(),true);});
    // Actual XLSX bytes -> file input -> parse -> controls -> assignment -> download -> read back.
    await check('real XLSX upload accepts unknown PT and marks robot continuation',async()=>{
      const bytes=await page.evaluate(()=>{const ws={};const put=(addr,v)=>ws[addr]={t:typeof v==='number'?'n':'s',v};put('F3','정주은');put('G3',1);put('N3','가상환자\nIN105');put('F4','신규치료사');put('G4',0);put('F5','김수현');put('G5',1);put('H5','로봇환자\nMM302-1');put('F6','김민수');put('G6',0);ws['!ref']='A1:BM6';const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,'일정');return Array.from(new Uint8Array(XLSX.write(wb,{type:'array',bookType:'xlsx'})));});
      await page.locator('#fileInput').setInputFiles({name:'가상_스케줄.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from(bytes)});
      await page.waitForFunction(()=>document.getElementById('fileStatus').textContent.includes('로드 완료'));
      assert.deepEqual(await page.evaluate(()=>PT_NAMES),['김수현','신규치료사','정주은']);
      assert.equal(await page.evaluate(()=>SCHED['김수현']['8:30']._cont),true);
      await page.locator('#absList input[value="정주은"]').check();await page.locator('#runBtn').click();
      assert.equal(await page.evaluate(()=>globalResultData.assigned[0].therapist),'신규치료사');
    });
    await check('downloaded XLSX contains actual assignment and updated schedule',async()=>{
      const waiting=page.waitForEvent('download');await page.locator('#expBtn').click();const download=await waiting;
      assert.equal(download.suggestedFilename(),'당일_대체_스케줄_결과.xlsx');
      const bytes=Array.from(fs.readFileSync(await download.path()));
      const data=await page.evaluate(bytes=>{const w=XLSX.read(new Uint8Array(bytes),{type:'array'});return {names:w.SheetNames,assigned:XLSX.utils.sheet_to_json(w.Sheets['배정 결과'],{header:1}),schedule:XLSX.utils.sheet_to_json(w.Sheets['업데이트 스케줄'],{header:1})};},bytes);
      assert.deepEqual(data.names,['배정 결과','미배정','업데이트 스케줄']);assert.equal(data.assigned[1][4],'신규치료사');assert.ok(data.schedule.find(r=>r[0]==='신규치료사').some(c=>String(c).includes('가상환자')));
    });
    await check('workbook-derived names and patient text are displayed as text',async()=>{
      const r=await scenario({'9:00':appt('IN105','<img src=x onerror=alert(1)>')},['<b>신규</b>']);
      assert.equal(r.assigned[0].therapist,'<b>신규</b>');
      assert.equal(await page.locator('#resultArea img').count(),0);
      await page.evaluate(()=>{populateControls();});
      assert.equal(await page.locator('#absList b').count(),0);
      assert.ok((await page.locator('#absList').innerText()).includes('<b>신규</b>'));
    });
    assert.deepEqual(errors,[]);console.log(`${passed} checks passed; no uncaught browser errors.`);
  } finally { if(browser) await browser.close(); await new Promise(r=>server.close(r)); }
})().catch(e=>{console.error(e);process.exitCode=1;});
