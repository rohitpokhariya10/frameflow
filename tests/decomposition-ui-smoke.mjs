import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
const browser = await chromium.launch({headless:true});
const page = await browser.newPage({viewport:{width:1440,height:1000}});
try {
 await page.goto('http://localhost:3001');
 await page.getByRole('tab',{name:'AI',exact:true}).click();
 await page.getByRole('button',{name:'Decompose',exact:true}).click();
 await page.getByRole('button',{name:'Use demo fixture',exact:true}).click();
 const jobResponse = page.waitForResponse(r=>r.url().endsWith('/api/decomposition/jobs')&&r.request().method()==='POST');
 await page.getByRole('button',{name:'Start decomposition',exact:true}).click();
 const response=await jobResponse; const job=await response.json();
 if(response.status()!==202)throw new Error(JSON.stringify(job));
 await page.getByText('Phase 6 of 6 — Extracted native layers ready',{exact:false}).waitFor({timeout:60000});
 const person=page.getByAltText('06-extracted/person.png',{exact:true}),board=page.getByAltText('06-extracted/board.png',{exact:true});
 await person.waitFor();await board.waitFor();
 for(const img of [person,board]){await img.scrollIntoViewIfNeeded();await img.evaluate(el=>el.decode());if(!await img.evaluate(el=>el.naturalWidth>0))throw new Error('Layer failed decoding');}
 await page.getByLabel('Inspection surface').selectOption('dark');
 await mkdir('test-results/decomposition',{recursive:true});
 await page.screenshot({path:'test-results/decomposition/phase6.png',fullPage:true});
 const result=await page.request.get(`http://localhost:3001/api/decomposition/jobs/${job.id}`);
 const status=await result.json();
 if(status.phase!==6||status.state!=='completed')throw new Error(JSON.stringify(status.error));
 console.log(JSON.stringify({jobId:job.id,phase:status.phase,state:status.state,artifacts:status.artifacts.length,providerMode:'mock',personVisible:true,boardVisible:true}));
 await page.reload();await page.getByRole('tab',{name:'AI',exact:true}).click();await page.getByRole('button',{name:'Decompose',exact:true}).click();
 await page.getByText('Phase 6 of 6 — Extracted native layers ready',{exact:false}).waitFor({timeout:10000});
 console.log('Refresh recovery passed.');
} finally {await browser.close();}
