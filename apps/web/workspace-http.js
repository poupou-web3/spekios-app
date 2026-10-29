// Transport shared by the workspace, issue history and agent connection pages.
// Each page retains its own session-expiry and rendering behavior.
export function workspaceRequest(path, {token='',body,headers={},timeoutMs=18000,signal}={}, fetcher=fetch) {
  if(typeof path!=='string'||!path.startsWith('/')||path.startsWith('//')||/[\\\x00-\x20\x7f]/.test(path)) {
    throw new Error('Workspace requests require a local absolute path.');
  }
  const timeout=AbortSignal.timeout(timeoutMs);
  return fetcher(path,{
    method:body===undefined?'GET':'POST',
    headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...headers,...(body===undefined?{}:{'Content-Type':'application/json'})},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),
    redirect:'error',signal:signal?AbortSignal.any([signal,timeout]):timeout,
  });
}

export async function requireOk(response) {
  if(response.ok)return response;
  let code='Request failed';
  try{const value=(await response.json()).error;if(typeof value==='string'&&value)code=value;}catch{}
  const error=new Error(code.replaceAll('_',' '));
  error.code=code;error.status=response.status;
  throw error;
}
