// Read-only comparison against approvals saved by the normal review workflow.
// Usage: node classifier/tests/check-reviewed-loops.mjs FOLDER [--check]
import {readFile} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {audioInfo,readWav} from '../audio.js';
import {assessPreparation} from '../preparation.js';

if(!process.argv[2]) { throw Error('Supply a prepared sample folder; --check requires every marked loop to match within 8 ms and its approved beat count.'); }
const root=resolve(process.argv[2]);
const read=relative=>{
    const file=resolve(root,relative);
    if(!file.startsWith(root+sep)) { throw Error('Sample path escapes the selected folder'); }
    return readFile(file);
};
const json=async relative=>JSON.parse(await read(relative));
const workspace=await json('.egc1/workspace.json'),evaluation=await json('.egc1/evaluation.json');
const cases=[];
for(const [id,review] of Object.entries(evaluation.reviews || {})) {
    if(review.quality!=='keep' || review.certainty!=='clear' || !review.tags?.includes('loops')) { continue; }
    const row=workspace.entries.find(row=>row.id===review.analysisId);
    if(!row || row.admission?.reviewedAt!==review.updatedAt || !Number.isInteger(review.boundaries?.attackFrame) || !Number.isInteger(review.boundaries?.endFrame)) { continue; }
    const file=new Blob([await read(row.path)]),info=await audioInfo(file);
    if(info.compressed) { continue; }
    const channels=await readWav(file,info);
    let analysis;
    try { analysis=await json(`.egc1/browser/raw-analysis/${row.id}.json`); }
    catch(error) {
        if(error.code!=='ENOENT') { throw error; }
        analysis=await json(`.egc1/entries/${row.id}.json`);
    }
    const actual=assessPreparation(channels,info.rate,analysis,review.tags,row.browserRoleEvidence);
    const offset=row.provenance?.start || 0;
    const expected={start:review.boundaries.attackFrame-offset,end:review.boundaries.endFrame-offset,beats:row.admission.correction.beats};
    const errorMs={start:(actual.bounds.start-expected.start)*1000/info.rate,end:(actual.bounds.end-expected.end)*1000/info.rate};
    const passing=Boolean(actual.phrase && !actual.reasons.length && actual.phrase.pulses===expected.beats && Object.values(errorMs).every(value=>Math.abs(value)<=8));
    cases.push({id,source:row.provenance?.sourcePath || row.path,offset,expected,
        actual:{...actual.bounds,beats:actual.phrase?.pulses},errorMs,reasons:actual.reasons,passing});
}
const report={cases:cases.length,passing:cases.filter(row=>row.passing).length,
    maxStartErrorMs:Math.max(0,...cases.map(row=>Math.abs(row.errorMs.start))),
    maxEndErrorMs:Math.max(0,...cases.map(row=>Math.abs(row.errorMs.end))),results:cases};
console.log(JSON.stringify(report,null,2));
if(process.argv.includes('--check') && (!cases.length || report.passing!==cases.length)) { process.exitCode=1; }
