// Recorded evidence images, fetched with the workspace session and cached as object URLs.
import {button,empty} from '/assets/ui/components.js';
import {esc} from '/assets/ui/format.js';
import {api} from './api.js';
import {imageCache,imagePending,root} from './state.js';
let imageEpoch = 0;
export function clearImages(){imageEpoch++;for(const url of imageCache.values())URL.revokeObjectURL(url);imageCache.clear();imagePending.clear();}
export async function loadImages(){
  for(const node of root.querySelectorAll('[data-image-path]')){
    const path=node.dataset.imagePath;
    if(imageCache.has(path)){node.replaceChildren(Object.assign(document.createElement('img'),{src:imageCache.get(path),alt:node.dataset.alt}));continue;}
    if(imagePending.has(path))continue;
    imagePending.add(path);const epoch=imageEpoch;
    try{const response=await api(path);const url=URL.createObjectURL(await response.blob());if(epoch!==imageEpoch){URL.revokeObjectURL(url);continue;}imageCache.set(path,url);for(const n of root.querySelectorAll('[data-image-path]'))if(n.dataset.imagePath===path)n.replaceChildren(Object.assign(document.createElement('img'),{src:url,alt:n.dataset.alt}));}
    catch(error){if(node.isConnected)node.textContent=`Image unavailable: ${error.message}`;}
    finally{imagePending.delete(path);}
  }
}
export function imagePanel(path,alt,pending=false){return path?`<div class="image-wrap" data-image-path="${esc(path)}" data-alt="${esc(alt)}"><span class="loading">Loading recorded image…</span></div><div class="evidence-tools">${button('zoom-image','Inspect at full resolution','image',`data-path="${esc(path)}" data-alt="${esc(alt)}"`)}<span class="small muted">Inspect small changes without shrinking the screenshot.</span></div>`:empty(pending?'Evidence is being collected':'No image available',pending?'This step has not finished recording its screenshot yet.':'This observation has an explicit evidence gap.','image');}
