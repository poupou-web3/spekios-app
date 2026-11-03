// Model-only derivatives. Originals and the exact raw difference mask stay intact.
import {PNG} from 'pngjs';
export const ATTENTION_VERSION='regions-quarter-v1';
export const ATTENTION_LIMITS=Object.freeze({region_area_fraction:.25,max_regions:32,max_crops:3,padding:24,overview_side:384,max_sheet_fraction:.65,max_sheet_side:8192});

/** Group changed tiles within quarter-screen cells. Never discard a one-pixel change. */
export function changeRegions(mask,areaLimit=Math.floor(mask.width*mask.height/4)){
  const {width,height,data}=mask,maxArea=Math.min(Math.floor(width*height/4),areaLimit);
  if(!maxArea)return {version:ATTENTION_VERSION,regions:[],complete:false,reason:'image_too_small',max_region_pixels:0};
  const cellW=Math.max(1,Math.min(Math.floor(width/2),maxArea)),cellH=Math.max(1,Math.min(Math.floor(height/2),Math.floor(maxArea/cellW)));
  const regions=[];let total=0;
  for(let cy=0;cy<height;cy+=cellH)for(let cx=0;cx<width;cx+=cellW){
    const right=Math.min(width,cx+cellW),bottom=Math.min(height,cy+cellH),tiles=new Map();
    for(let ty=0;cy+ty*16<bottom;ty++)for(let tx=0;cx+tx*16<right;tx++){
      const t={tx,ty,left:right,top:bottom,right:cx,bottom:cy,count:0};
      for(let y=cy+ty*16;y<Math.min(bottom,cy+(ty+1)*16);y++)for(let x=cx+tx*16;x<Math.min(right,cx+(tx+1)*16);x++)if(data[(y*width+x)*4]){
        t.left=Math.min(t.left,x);t.top=Math.min(t.top,y);t.right=Math.max(t.right,x+1);t.bottom=Math.max(t.bottom,y+1);t.count++;
      }
      if(t.count){total+=t.count;tiles.set(`${tx},${ty}`,t);}
    }
    while(tiles.size){
      const first=tiles.values().next().value,queue=[first];tiles.delete(`${first.tx},${first.ty}`);
      let left=right,top=bottom,r=cx,b=cy,count=0;
      for(let n=0;n<queue.length;n++){
        const t=queue[n];left=Math.min(left,t.left);top=Math.min(top,t.top);r=Math.max(r,t.right);b=Math.max(b,t.bottom);count+=t.count;
        for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const key=`${t.tx+dx},${t.ty+dy}`,next=tiles.get(key);if(next){tiles.delete(key);queue.push(next);}}
      }
      // Padding cannot cross a cell boundary, so even padded crops obey the cap.
      left=Math.max(cx,left-ATTENTION_LIMITS.padding);top=Math.max(cy,top-ATTENTION_LIMITS.padding);r=Math.min(right,r+ATTENTION_LIMITS.padding);b=Math.min(bottom,b+ATTENTION_LIMITS.padding);
      regions.push({x:left,y:top,width:r-left,height:b-top,changed_pixels:count});
    }
  }
  regions.sort((a,b)=>b.changed_pixels-a.changed_pixels||a.y-b.y||a.x-b.x);
  const selected=regions.slice(0,ATTENTION_LIMITS.max_regions),covered=selected.reduce((n,r)=>n+r.changed_pixels,0);
  return {version:ATTENTION_VERSION,max_region_pixels:maxArea,region_area_fraction:.25,regions:selected,region_count:regions.length,complete:covered===total,changed_pixels:total,omitted_changed_pixels:total-covered};
}
function within(a,b){return a.x>=b.x&&a.y>=b.y&&a.x+a.width<=b.x+b.width&&a.y+a.height<=b.y+b.height;}
function area(r){return r.width*r.height;}
function cropControl(rect,width,height){
  if(!rect||!['x','y','width','height'].every(k=>Number.isFinite(rect[k]))||rect.width<=0||rect.height<=0)return null;
  const left=Math.max(0,Math.floor(rect.x)-ATTENTION_LIMITS.padding),top=Math.max(0,Math.floor(rect.y)-ATTENTION_LIMITS.padding),right=Math.min(width,Math.ceil(rect.x+rect.width)+ATTENTION_LIMITS.padding),bottom=Math.min(height,Math.ceil(rect.y+rect.height)+ATTENTION_LIMITS.padding);
  return right>left&&bottom>top?{x:left,y:top,width:right-left,height:bottom-top,reason:'interacted_control'}:null;
}
function copy(source,dest,sourceRect,x,y){
  for(let row=0;row<sourceRect.height;row++)source.data.copy(dest.data,((y+row)*dest.width+x)*4,((sourceRect.y+row)*source.width+sourceRect.x)*4,((sourceRect.y+row)*source.width+sourceRect.x+sourceRect.width)*4);
}
/** Two contact sheets: small whole-page overview followed by exact native crops. */
export function assessmentSheets(before,after,comparison,controlRect){
  const full=reason=>({mode:'full',version:ATTENTION_VERSION,reason});
  if(before.width!==after.width||before.height!==after.height)return full('geometry_changed');
  const width=before.width,height=before.height,pixels=width*height,focus=comparison.focus_regions;
  if(!focus?.complete||focus.regions.length>ATTENTION_LIMITS.max_crops)return full('changes_too_broad_or_fragmented');
  const control=cropControl(controlRect,width,height);if(!control)return full('interacted_control_unavailable');
  if(area(control)>Math.floor(pixels/4))return full('interacted_control_too_large');
  const regions=focus.regions.map(r=>({...r,reason:'changed_pixels'}));
  if(!regions.some(r=>within(control,r)))regions.unshift(control);
  // Remove wholly redundant crops without merging disconnected regions.
  const crops=regions.filter((r,i)=>!regions.some((other,j)=>j!==i&&within(r,other)&&(area(other)>area(r)||j<i)));
  if(crops.length>ATTENTION_LIMITS.max_crops)return full('too_many_focus_regions');
  const factor=Math.min(1,ATTENTION_LIMITS.overview_side/Math.max(width,height)),ow=Math.max(1,Math.floor(width*factor)),oh=Math.max(1,Math.floor(height*factor));
  const sheetW=Math.max(ow,...crops.map(r=>r.width)),sheetH=oh+crops.reduce((n,r)=>n+r.height+8,0);
  if(sheetW>ATTENTION_LIMITS.max_sheet_side||sheetH>ATTENTION_LIMITS.max_sheet_side)return full('derivative_dimensions_exceed_limits');
  if(sheetW*sheetH>=pixels*ATTENTION_LIMITS.max_sheet_fraction)return full('no_meaningful_pixel_reduction');
  const panels=[{kind:'overview',source:{x:0,y:0,width,height},image:{x:0,y:0,width:ow,height:oh},scale:factor}];
  let y=oh+8;for(const r of crops){panels.push({kind:r.reason,source:r,image:{x:0,y,width:r.width,height:r.height},scale:1});y+=r.height+8;}
  const images=[before,after].map(source=>{
    const sheet=new PNG({width:sheetW,height:sheetH});sheet.data.fill(245);for(let n=3;n<sheet.data.length;n+=4)sheet.data[n]=255;
    for(let py=0;py<oh;py++)for(let px=0;px<ow;px++){
      const sx=Math.min(width-1,Math.floor(px*width/ow)),sy=Math.min(height-1,Math.floor(py*height/oh));
      source.data.copy(sheet.data,(py*sheetW+px)*4,(sy*width+sx)*4,(sy*width+sx)*4+4);
    }
    for(const panel of panels.slice(1))copy(source,sheet,panel.source,panel.image.x,panel.image.y);
    return PNG.sync.write(sheet);
  });
  return {mode:'overview_and_crops',version:ATTENTION_VERSION,width:sheetW,height:sheetH,source_pixels_per_image:pixels,sent_pixels_per_image:sheetW*sheetH,pixel_fraction:sheetW*sheetH/pixels,panels,images,
    note:'The first image is before, the second after. Each has a reduced overview on top and matching native-resolution crops below. Source coordinates refer to original screenshots; image coordinates refer to the contact sheet. Inspect focus crops first, then check the expected result and the overview. A missing change may be a failure. Request full screenshots if context or detail is insufficient. Pixel reduction is not a measured token saving.'};
}
