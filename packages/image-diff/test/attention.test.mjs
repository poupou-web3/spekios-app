import test from 'node:test';
import assert from 'node:assert/strict';
import {PNG} from 'pngjs';
import {comparePng,assessmentImageSheets} from '../index.mjs';
const ids={beforeCaptureId:'before',afterCaptureId:'after'};
function image(w,h,points=[]){const p=new PNG({width:w,height:h});p.data.fill(255);for(const [x,y]of points)p.data[(y*w+x)*4]=0;return PNG.sync.write(p);}
function verifyRegions(diff,w,h){const f=diff.metadata.focus_regions;assert(f.regions.every(r=>r.width*r.height<=Math.floor(w*h/4)&&r.x>=0&&r.y>=0&&r.x+r.width<=w&&r.y+r.height<=h));return f;}
test('separated one-pixel changes stay visible in distinct quarter-capped padded regions',()=>{
  const points=[[0,0],[399,199],[200,100],[70,70]],d=comparePng(image(400,200),image(400,200,points),ids),f=verifyRegions(d,400,200);
  assert.equal(f.complete,true);assert.equal(f.changed_pixels,points.length);
  for(const [x,y]of points)assert(f.regions.some(r=>x>=r.x&&y>=r.y&&x<r.x+r.width&&y<r.y+r.height));
});
test('full-screen, odd and narrow geometry changes obey the area cap and preserve exact change counts',()=>{
  for(const [w,h]of [[101,99],[17,1],[1,17],[2,2]]){
    const before=image(w,h),after=image(w,h,Array.from({length:w*h},(_,n)=>[n%w,Math.floor(n/w)]));
    const f=verifyRegions(comparePng(before,after,ids),w,h);assert(f.complete);assert.equal(f.changed_pixels,w*h);assert.equal(f.regions.reduce((n,r)=>n+r.changed_pixels,0),w*h);
  }
});
test('fragmented noise is explicitly incomplete and never silently becomes cropped coverage',()=>{
  const points=[];for(let y=5;y<900;y+=64)for(let x=5;x<1440;x+=64)points.push([x,y]);
  const before=image(1440,900),after=image(1440,900,points),d=comparePng(before,after,ids),f=verifyRegions(d,1440,900);
  assert.equal(f.complete,false);assert(f.omitted_changed_pixels>0);
  assert.equal(assessmentImageSheets(before,after,d.metadata,{x:10,y:10,width:100,height:20}).mode,'full');
});
test('native detail preserves exact source pixels, source buffers and a smaller whole-page overview',()=>{
  const before=image(1440,900),after=image(1440,900,[[400,350]]),saved=Buffer.from(after),d=comparePng(before,after,ids);
  const result=assessmentImageSheets(before,after,d.metadata,{x:380,y:320,width:100,height:40});
  assert.equal(result.mode,'overview_and_crops');assert.deepEqual(after,saved);assert.equal(result.images.length,2);assert(result.pixel_fraction<.65);
  const sheet=PNG.sync.read(result.images[1]);assert.equal(sheet.width*sheet.height,result.sent_pixels_per_image);
  for(const p of result.panels.slice(1)){
    assert(p.source.width*p.source.height<=1440*900/4);
    const source=PNG.sync.read(after);
    for(let y=0;y<p.source.height;y++)for(let x=0;x<p.source.width;x++){
      const a=((y+p.source.y)*source.width+x+p.source.x)*4,b=((y+p.image.y)*sheet.width+x+p.image.x)*4;
      assert.deepEqual(sheet.data.subarray(b,b+4),source.data.subarray(a,a+4));
    }
  }
});
test('geometry changes, oversized controls and uneconomic small screenshots retain full images',()=>{
  const before=image(200,100),after=image(200,100,[[5,5]]),d=comparePng(before,after,ids);
  assert.equal(assessmentImageSheets(before,after,d.metadata,{x:0,y:0,width:200,height:100}).mode,'full');
  const changed=image(201,100),geometry=comparePng(before,changed,ids);assert.equal(assessmentImageSheets(before,changed,geometry.metadata,{x:0,y:0,width:10,height:10}).reason,'geometry_changed');
  assert.equal(assessmentImageSheets(before,after,d.metadata,{x:10,y:10,width:1,height:1}).mode,'full');
});

test('orthogonal geometry uses the smaller source screen for the quarter-area cap',()=>{
 const d=comparePng(image(400,100),image(100,400),ids),f=d.metadata.focus_regions;
 assert.equal(f.max_region_pixels,10000);assert(f.regions.every(r=>r.width*r.height<=10000));assert.equal(f.changed_pixels,60000);
});
