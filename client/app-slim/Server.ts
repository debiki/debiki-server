/*
 * Copyright (c) 2014-2017 Kaj Magnus Lindberg
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

/// <reference path="model.ts" />
/// <reference path="links.ts" />
/// <reference path="ServerApi.ts" />

// Ought to include, but then `debiki2.createComponent` gets placed too late —> JS breaks:
//xx <reference path="ReactActions.ts" />
//xx <reference path="page-dialogs/server-error-dialog.ts" />
// Not important to fix right now — everything works fine anyway.

//------------------------------------------------------------------------------
   namespace debiki2.Server {
//------------------------------------------------------------------------------

const d: any = { i: debiki.internal };

const BadNameOrPasswordErrorCode = '_TyE403BPWD';
const NoPasswordErrorCode = '_TyMCHOOSEPWD';

const XsrfTokenHeaderName = 'X-XSRF-TOKEN'; // CLEAN_UP rename to X-Ty-Xsrf-Token
const SessionIdHeaderName = 'X-Ty-Sid';
const AvoidCookiesHeaderName = 'X-Ty-Avoid-Cookies';

function getPageId(): PageId {
  return eds.embeddedPageId || // [4HKW28]
      ReactStore.allData().currentPageId;
}

interface OngoingRequest {
  abort();
}

interface RequestData {
  data?: JsonData;
  success?: (response: any) => void;
  error?: (xhr: XMLHttpRequest) => any;
  showLoadingOverlay?: boolean;
}


interface NewEmbCommentsPageIdCatUrl {
  discussionId?: string;
  embeddingUrl?: string;
  lazyCreatePageInCatId?: CategoryId;
}


function postJson(urlPath: string, requestData: RequestData) {
  let url = appendE2eAndForbiddenPassword(origin() + urlPath);
  const timeoutHandle = showWaitForRequestOverlay(requestData.showLoadingOverlay !== false);

  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Requested-With': 'XMLHttpRequest',
  };

  headers[XsrfTokenHeaderName] = getSetCookie('XSRF-TOKEN');

  addAnyNoCookieHeaders(headers);

  // DO_AFTER 2021-01-01: Use the native fetch() [FETCHEX] and remove Bliss.fetch.
  // IE11 needs a shim: https://github.com/github/fetch  — but IE11 doesn't work anyway.

  Bliss.fetch(url, {
    method: 'POST',
    data: JSON.stringify(requestData.data || null),
    headers,
  }).then(xhr => {
    removeWaitForRequestOverlay(timeoutHandle);
    if (requestData.success) {
      // Remove any AngularJS safe json prefix. [5LKW02D4]
      let response = xhr.response.replace(/^\)]}',\n/, '');
      response = response ? JSON.parse(response) : null;
      try {
        requestData.success(response);
      }
      catch (ex) {
        const message = "Error handling POST response [TyEPOSTCLBK]";
        console.error(`${message} from: ${url}`, ex);
        pagedialogs.getServerErrorDialog().openForBrowserError(
            ex.toString?.() || message);
      }
    }
  }).catch(errorObj => {
    removeWaitForRequestOverlay(timeoutHandle);
    const errorAsJson = JSON.stringify(errorObj);
    const details = errorObj.xhr && errorObj.xhr.responseText ?
        errorObj.xhr.responseText : errorObj.stack;
    // error: (jqXhr: any, textStatus: string, errorThrown: string) => {
    // COULD ensure all callers survive xhr == null, and call them also if !xhr,
    // but currently an unknown caller dies on null, so:
    let perhapsIgnoreError;
    if (requestData.error && errorObj.xhr) {
      perhapsIgnoreError = requestData.error(errorObj.xhr);
      if (perhapsIgnoreError === IgnoreThisError)
        return;
    }
    console.error(`Error POSTing to ${urlPath}: ${errorAsJson}, details: ${details}`);
    if (perhapsIgnoreError === ShowNoErrorDialog) {
      // Noop.
    }
    else if (errorObj.xhr) {
      pagedialogs.getServerErrorDialog().open(errorObj.xhr);
    }
    else {
      pagedialogs.getServerErrorDialog().openForBrowserError(
          errorObj.stack || 'Unknown error [EdEUNK1]');
    }
  });
}


/* The real native fetch(), usage example:  [FETCHEX]

function sendFetchRequest(onOk: (response) => void, onError: ErrorStatusHandler) {

  const anyAbortController = ('AbortController' in self) ? new AbortController() : undefined;

  let options: any = {
    credentials: 'same-origin',
    // This fails requests to external origins.
    mode: 'same-origin',
    referrer: 'no-referrer',
    redirect: 'error',
    signal: anyAbortController ? anyAbortController.signal : undefined,
    headers: {
      'Content-Type': 'application/json',  // don't forget, if POSTing.
    },
  }

  const ongoingRequest = fetch('/something', options).then(function(response) {
    // This means the response http headers have arrived — we also need to wait
    // for the response body.
    if (response.status === 200) {
      console.trace(`Request response headers, status 200 OK`);
      response.json().then(function(json) {
        console.debug(`Response json [TyMSWLPRRESP]: ` + JSON.stringify(json));
        onOk(json);
      }).catch(function(error) {
        console.warn(`Request failed: got headers, status 200, ` +
            `but no json [TyESWLP0JSN]`);
        onError(200);
      });
    }
    else if (response.status === 408) {
      console.debug(`Request status 408 Timeout [TyMSWLPRTMT]`);
    }
    else {
      console.warn(`Request error response, status ${response.status} [TyESWLPRERR]`);
      onError(response.status);
    }
  }).catch(function(error) {
    console.warn(`Request failed, no response [TyESWLP0RSP]`);
    onError(0);
  });

  anyAbortController.abort();
}

*/

interface PendingFetch {
  request,
  abort: () => void;
}


// ---------------------------------------------------------------
// @ifdef DEBUG
// This fn not yet needed — nice to have though, when trying out CORS requests.
// And later, when using fetch() everywhere.  [FETCHEX]

// Fetches, via a POST requests, stuff from another server. [CORSPOST]
// Shows what went wrong (if anything).
// This will only work, if that other server has been configured to allow
// CORS requests from the current server (current origin).
//
// This could almost be a blog post (!) — so many things can go wrong,
// What about open sourcing this fn under MIT?
//
export function corsPost(ps: { url: string, xsrfToken: string, data: any,
        onDone: (responseJson) => void, onError?: ErrorDetailsStatusHandler })
        : PendingFetch {

  const onError: ErrorDetailsStatusHandler = function(statusCode, statusText, ex?) {
    try {
      ps.onError?.(statusCode, statusText, ex);
    }
    catch (ex2) {
      console.error(`Error in error handler, after corsPost():ing to ${ps.url} ` +
            `and handling respone status ${statusCode} ${statusText}: `, ex2);
    }
  }

  dieIf(_.isString(ps.data),
      "'data' should be a javascript object not a string [TyE503RSKDH]");

  // There are browsers with fetch() but no AbortController, e.g. UC Browser for Android
  // and Opera Mini (this as of 2020-06).
  const anyAbortController = ('AbortController' in self) ?
          new AbortController() : undefined;

  const method = 'POST';

  const options: RequestInit = {
    // Could specify 'same-origin', but then harder to troubleshoot, when such
    // requests look different.
    credentials: 'omit',
    method,
    keepalive: true,
    // This makes the response body readable for this in-browser Javascript code.
    mode: 'cors',
    referrer: 'no-referrer',
    // Don't follow redirects.
    redirect: 'error',
    signal: anyAbortController?.signal,
    headers: {
      'Content-Type': 'application/json',  // if POSTing.
    },
    body: JSON.stringify(ps.data),
  };

  // Do here, so won't add any `xsrf: undefined` field, if missing — that'd
  // get sent as "undefined" (a string).
  if (ps.xsrfToken) {
    options.headers['X-Xsrf-Token'] = ps.xsrfToken;
  }

  const ongoingRequest = fetch(ps.url, options).then(function(response) {
    // We got the response http headers. Get the body too, also if we got an error
    // status code — so we can show details from the response body about what
    // went wrong. Use text() not json() so we can print the response body if it's
    // a plain text error message, or corrupt json that caused a parse error.
    console.trace(`Got fetch() response headers: ${response.status
          } ${response.statusText} [TyMGOTHDRS]`);

    response.text().then(function(text) {
      console.trace(`Got fetch() response text [TyMGOTTXT]: ` + text);

      if (response.status !== 200) {
        console.error(`fetch() error response, status ${response.status
                } ${response.statusText} [TyEFETCHERR], response text:\n${text}`);
        onError(response.status, response.statusText, text);
        return;
      }

      let json;
      try { json = JSON.parse(text) }
      catch (ex) {
        console.error(`Error parsing JSON in fetch() 200 ${response.statusText
              } response [TyEFETCH0JSN]:\n${text}`, ex);
        onError(200, response.statusText, "Error parsing response json");
        return;
      }

      try { ps.onDone(json) }
      catch (ex) {
        console.error(`Error in fetch() 200  ${response.statusText
              } response handler [TyERSPHNDL]`, ex);
      }
    }).catch(function(error) {
      console.error(`Error getting fetch() response body [TyEFETCH0BDY]: `, error);
      onError(response.status, response.statusText, error);
    });
  }).catch(function(error) {
    console.error(`fetch() failed, no response [TyEFETCHFAIL]: `, error);
    onError(0, '', error);
  });

  return {
    request: ongoingRequest,
    abort: !anyAbortController ? null : () => anyAbortController.abort(),
  };
}

// In Javascript:
/*

ex:  corsPost({ url: 'http://site-3.localhost/-/v0/search', data: {},
        onDone: r => { console.log('RSLT: ' + JSON.stringify(r)); }  });

function corsPost(ps) {  

  const onError = function(statusCode, statusText, ex) {
    try {
      !ps.onError || ps.onError(statusCode, statusText, ex);
    }
    catch (ex2) {
      console.error(`Error in error handler, after corsPost():ing to ${ps.url} ` +
            `and handling respone status ${statusCode} ${statusText}: `, ex2);
    }
  }

  // There are browsers with fetch() but no AbortController, e.g. UC Browser for Android
  // and Opera Mini (this as of 2020-06).
  const anyAbortController = ('AbortController' in self) ?
          new AbortController() : undefined;

  const method = 'POST';

  const options = {
    // Could specify 'same-origin', but then harder to troubleshoot, when such
    // requests look different.
    credentials: 'omit',
    method,
    keepalive: true,
    // This makes the response body readable for this in-browser Javascript code.
    mode: 'cors',
    referrer: 'no-referrer',
    // Don't follow redirects.
    redirect: 'error',
    signal: anyAbortController?.signal,
    headers: {
      'Content-Type': 'application/json',  // if POSTing.
    },
    body: JSON.stringify(ps.data),
  };

  // Do here, so won't add any `xsrf: undefined` field, if missing — that'd
  // get sent as "undefined" (a string).
  if (ps.xsrfToken) {
    options.headers['X-Xsrf-Token'] = ps.xsrfToken;
  }

  const ongoingRequest = fetch(ps.url, options).then(function(response) {
    // We got the response http headers. Get the body too, also if we got an error
    // status code — so we can show details from the response body about what
    // went wrong. Use text() not json() so we can print the response body if it's
    // a plain text error message, or corrupt json that caused a parse error.
    console.trace(`Got fetch() response headers: ${response.status
          } ${response.statusText} [TyMGOTHDRS]`);

    response.text().then(function(text) {
      console.trace(`Got fetch() response text [TyMGOTTXT]: ` + text);

      if (response.status !== 200) {
        console.error(`fetch() error response, status ${response.status
                } ${response.statusText} [TyEFETCHERR], response text:\n${text}`);
        onError(response.status, response.statusText, text);
        return;
      }

      let json;
      try { json = JSON.parse(text) }
      catch (ex) {
        console.error(`Error parsing JSON in fetch() 200 ${response.statusText
              } response [TyEFETCH0JSN]:\n${text}`, ex);
        onError(200, response.statusText, "Error parsing response json");
        return;
      }

      try { ps.onDone(json) }
      catch (ex) {
        console.error(`Error in fetch() 200  ${response.statusText
              } response handler [TyERSPHNDL]`, ex);
      }
    }).catch(function(error) {
      console.error(`Error getting fetch() response body [TyEFETCH0BDY]: `, error);
      onError(response.status, response.statusText, error);
    });
  }).catch(function(error) {
    console.error(`fetch() failed, no response [TyEFETCHFAIL]: `, error);
    onError(0, '', error);
  });

  return {
    request: ongoingRequest,
    abort: !anyAbortController ? null : () => anyAbortController.abort(),
  };
}

*/
// @endif
// ---------------------------------------------------------------


export function uploadFiles(endpoint: string, files: any[], onDone, onError) {  // [FETCHEX]
  dieIf(files.length !== 1,  `${files.length} files [TyE06WKTDN23]`);
  const headers = {};
  headers[XsrfTokenHeaderName] = getSetCookie('XSRF-TOKEN');
  fetch(endpoint, {
    method: 'POST',
    body: files[0],
    headers,
  })
  .then((response: Response) => {
    logM("Uploaded file. [TyM306KWRDF2]");
    // Clone the respones, otherwie `.text()` fails with a
    // "TypeError: Failed to execute 'text' on 'Response': body stream is locked" error,
    // if one has Dev Tools open and inspects the response in Dev Tools.
    return response.clone().text().then(
      responseText => cloneReponseToObj(response, responseText));
  })
  .then((respObj: ResponseObj) => {
    if (respObj.status !== 200) {
      const errCode = 'TyEBADFETCHRESP';
      const message = `Status ${respObj.status} error when uploading file ` +
          `to ${endpoint} [${errCode}]:\n\n${respObj.responseText}`;
      console.error(message);
      pagedialogs.getServerErrorDialog().open(respObj);
      onError(message);
      return errCode;
    }
    else {
      // Remove any AngularJS safe json prefix. [5LKW02D4]
      const jsonStr = respObj.responseText.replace(/^\)]}',\n/, '');
      const json = JSON.parse(jsonStr);
      onDone(json);
      return json;
    }
  })
  .catch(error => {
    console.error(`Error uploading file to ${endpoint} [TyE7FKSH260]`, error);
    pagedialogs.getServerErrorDialog().open(error);
    onError(error);
    return error;
  });
}


function cloneReponseToObj(response: Response, responseText: string): ResponseObj {
  return {
    headers: response.headers,
    ok: response.ok,
    redirected: response.redirected,
    status: response.status,
    statusText: response.statusText,
    type: response.type,
    url: response.url,
    responseText,
  };
}


function trySendBeacon(url, data) {
  // sendBeacon is not supported in Safari and iOS as of Feb 2017 ... and Aug 2018.
  let sendBeacon = navigator['sendBeacon'];
  if (!sendBeacon) {
    // Bad luck, likely Apple's iOS.
    return;
  }

  // 1. Don't call variable `sendBeacon`, that results in an invalid-invokation error.
  // 2. sendBeacon() apparently always posts text/plain;charset=UTF-8.
  // 3. There's no way to add a xsrf header — so include a xsrf token in the request body.
  let xsrfTokenLine = getSetCookie('XSRF-TOKEN') + '\n';  // [7GKW20TD]
  let json = JSON.stringify(data);
  (<any> navigator).sendBeacon(url + '-text', xsrfTokenLine + json);
}


// If needed later:
// loadCss: use https://github.com/filamentgroup/loadCSS/blob/master/src/loadCSS.js
// SMALLER_BUNDLE use Bliss.load() instead? Works for both js and css.
//
export function loadJs(src: string, onOk?: () => void, onError?: () => void): any {  // : Promise, but compilation error
  const promise = new Promise(function (resolve, reject) {
    const scriptElem = document.createElement('script');
    scriptElem.src = src;
    scriptElem.onload = resolve;
    scriptElem.onerror = reject;
    document.head.appendChild(scriptElem);
  });
  promise.catch(function(error) {
    const message =`Error loading script ${src}: ${error.toString()} [EdELDJSERR]`;
    console.error(message);
    console.error(error);
    pagedialogs.getServerErrorDialog().open(message);
  });
  if (onOk) promise.then(onOk);
  if (onError) promise.catch(onError);
  return promise;
}


let globalStaffScriptLoaded = false;

export function maybeLoadGlobalStaffScript() {
  // A bit hacky: e2e test site hostnames contain '-test-', and test sites people
  // create to try out the admin features, instead starts with 'test--' [5UKF03].
  // We don't want any global feedback widget scripts or whatever, to load for e2e tests
  // (because the tests would break, if they clicked those widgets) — so don't load any
  // script, for '-test-' hostnames (but do load, for 'test--' hostnames).
  if (location.hostname.indexOf('-test-') >= 0) return;
  if (!globalStaffScriptLoaded && eds.loadGlobalStaffScript) {
    loadJs(eds.cdnOrServerOrigin + '/-/globalStaffScript.js');
    globalStaffScriptLoaded = true;
  }
}


let globalAdminScriptLoaded = false;

export function maybeLoadGlobalAdminScript() {
  if (location.hostname.indexOf('-test-') >= 0) return;  // [5UKF03]
  if (!globalAdminScriptLoaded && eds.loadGlobalAdminScript) {
    loadJs(eds.cdnOrServerOrigin + '/-/globalAdminScript.js');
    globalAdminScriptLoaded = true;
  }
}


type RequestTimeoutHandle = number[];

function showWaitForRequestOverlay(shallShow: boolean): RequestTimeoutHandle | undefined {
  if (!shallShow)
    return;

  const timeoutHandle = [];
  showLoadingOverlay();
  timeoutHandle[0] = setTimeout(function() {
    maybeShowServerJustStartedMessage();
    // 2nd timeout:
    timeoutHandle[0] = setTimeout(showErrorIfNotComplete, 21 * 1000);
  }, 9 * 1000);

  return timeoutHandle;
}


function removeWaitForRequestOverlay(timeoutHandle: RequestTimeoutHandle) {
  if (timeoutHandle) {
    const actualHandle = timeoutHandle[0]
    if (actualHandle) {
      clearTimeout(actualHandle);
    }
    removeLoadingOverlay();
  }
}


function showLoadingOverlay() {
  document.body.appendChild(
      $h.parseHtml('<div id="theLoadingOverlay"><div class="icon-loading"></div></div>')[0]);
}


function maybeShowServerJustStartedMessage() {
  const overlayElem = $byId('theLoadingOverlay');
  if (!overlayElem) return;
  const messageElem =
      $h.parseHtml('<div id="theServerJustStarted">' +
      "<p>This takes long ...</p>" +
      "<p>If many browser tabs are open to this site,<br>close a few.</p>" +
      "<p>Or maybe the server was just started, and is slow.</p>" +
      '</div>')[0];
  $h.addClasses(overlayElem, 'esLoadingSlow');
  overlayElem.appendChild(messageElem);
}


function removeLoadingOverlay() {
  const overlay = $byId('theLoadingOverlay');
  if (overlay) overlay.remove();
}


function showErrorIfNotComplete() {
  const stillLoading = !!$byId('theLoadingOverlay');
  if (stillLoading) {
    // Remove the spinner before showing the dialog.
    Bliss('#theLoadingOverlay .icon-loading').remove();
    alert("Error: Server too slow [EsE5YK0W24]");
    removeLoadingOverlay();
  }
}


export const testPost = postJsonSuccess;

type JsonData = object | any[];
type OnErrorFn = (xhr: XMLHttpRequest) => any;

/** Return Server.IgnoreThisError from error(..) to suppress a log message and error dialog.
  */
function postJsonSuccess(
  urlPath: string,
  onOk: ((response: any) => void) | UseBeacon,  // RENAME all onDone and success to onOk
  data: JsonData | OnErrorFn,
  onError?: JsonData | OnErrorFn,
  options?: { showLoadingOverlay?: boolean },  // default true, for POST requests
  ) {

  // Make postJsonSuccess(..., onError, data) work:
  if (!data || _.isFunction(data)) {
    const tmp = data;
    data = onError;
    onError = tmp;
  }

  if (onOk === UseBeacon) {
    trySendBeacon(urlPath, data);
    return;
  }

  options = options || {};
  postJson(urlPath, {
    data: data,
    success: onOk,
    error: onError as OnErrorFn,
    showLoadingOverlay: options.showLoadingOverlay,
  });
}


export const testGet = get;

type GetSuccessFn = (response, xhr?: XMLHttpRequest) => void;
type GetErrorFn = (errorDetails: string, status?: number) => void;

interface GetOptions {
  dataType?: string;
  headers?: { [headerName: string]: string }
  timeout?: number;
  suppressErrorDialog?: boolean;
  showLoadingOverlay?: true;  // default false, for GET requests
}


function get(uri: string, successFn: GetSuccessFn, errorFn?: GetErrorFn, options?: GetOptions)
    : OngoingRequest {

  options = options || {};
  const headers = options.headers || {};

  headers['X-Requested-With'] = 'XMLHttpRequest';

  addAnyNoCookieHeaders(headers);

  const timeoutHandle = showWaitForRequestOverlay(options?.showLoadingOverlay === true);

  const promiseWithXhr = <any> Bliss.fetch(origin() + uri, {  // hack, search for "Hack" in fetch()
    method: 'GET',                                            // in client/third-party/bliss.shy.js
    headers: headers,
    timeout: options.timeout,
  });
  promiseWithXhr.then(xhr => {
    removeWaitForRequestOverlay(timeoutHandle);
    let response = xhr.response;
    if (options.dataType !== 'html') {
      // Then it's json, what else could it be? Remove any AngularJS safe json prefix. [5LKW02D4]
      response = xhr.response.replace(/^\)]}',\n/, '');
      response = JSON.parse(response);
    }
    try {
      successFn(response, xhr);
    }
    catch (ex) {
      const message = "Error handling GET response [TyEGETCLBK]"
      console.error(`${message} from: ${uri}`, ex);
      pagedialogs.getServerErrorDialog().openForBrowserError(
          ex.toString?.() || message);
    }
  }).catch(errorObj => {
    removeWaitForRequestOverlay(timeoutHandle);
    const errorAsJson = JSON.stringify(errorObj);
    const details: string = errorObj.xhr ? errorObj.xhr.responseText : errorObj.stack;
    console.error(`Error GETting from ${uri}: ${errorAsJson}, details: ${details}`);
    let maybeIgnoreError;
    if (errorFn) {
      maybeIgnoreError = errorFn(details, errorObj.status);
    }
    if (!options.suppressErrorDialog && maybeIgnoreError !== IgnoreThisError) {
      const errorDialog = pagedialogs.getServerErrorDialog();
      if (errorObj.xhr) {
        errorDialog.open(errorObj.xhr);
      }
      else {
        errorDialog.openForBrowserError(errorObj.stack || 'Unknown error [EdEUNK2]');
      }
    }
  });

  return {
    abort: function() {
      // Unlike with jQuery, this abort() won't trigger the promise's error handler above,
      // i.e. won't call `catch(...)` above.
      promiseWithXhr.xhr.abort();
    }
  }
}


/**
 * Sends xsrf token and sid in headers, instead of cookies, because sometimes
 * the browsers refuse to use cookies, e.g. Privacy Badger blocks cookies or iOS
 * incorrectly thinks we're doing some kind of cross site tracking.
 */
export function addAnyNoCookieHeaders(headers: { [headerName: string]: St }) {  // [NOCOOKIES]
  const mainWin = getMainWin();

  // @ifdef DEBUG
  logD(`This window name: ${window.name} [TyM306WKTH2]`);
  logD(`This is the main window: ${window === mainWin}`);
  try {
    logD("Window.opener.typs: " +
        (window.opener && JSON.stringify(window.opener.typs)));
  }
  catch (ignored) {
    logD("Window.opener.typs: Threw exception. Opened from cross-origin window?");
  }
  logD(`Main win name: ${mainWin.name}`);
  logD(`Main win typs: ${JSON.stringify(mainWin.typs)}`);
  // @endif

  const typs: PageSession = mainWin.typs;
  const currentPageXsrfToken = typs.xsrfTokenIfNoCookies;
  const currentPageSid = typs.weakSessionId;

  if (!win_canUseCookies(mainWin)) {
    headers[AvoidCookiesHeaderName] = 'Avoid';
    // Not sure if can have been set to xsrf cookie value already? So skip if set.
    if (!headers[XsrfTokenHeaderName]) {
      headers[XsrfTokenHeaderName] = currentPageXsrfToken;
    }
  }

  if (currentPageSid) {
    headers[SessionIdHeaderName] = currentPageSid;
  }
}


function appendE2eAndForbiddenPassword(url: string) {
  let newUrl = url;
  const e2eTestPassword = anyE2eTestPassword();
  const forbiddenPassword = anyForbiddenPassword();
  if (e2eTestPassword || forbiddenPassword) {
    if (newUrl.indexOf('?') === -1) newUrl += '?';
    if (e2eTestPassword) newUrl += '&e2eTestPassword=' + e2eTestPassword;
    if (forbiddenPassword) newUrl += '&forbiddenPassword=' + forbiddenPassword;
  }
  return newUrl;
}


let editorScriptsPromise: Promise<any>;
let moreScriptsPromise: Promise<any>;
let hasStartedLoading2dScripts = false;
let staffScriptsPromise: Promise<any>;
let jQueryPromise: Promise<any>;


// Won't call callback() until a bit later — so if you call React's setState(..), the
// state will have changed.
//
export function loadEditorAndMoreBundles(callback?) {
  setTimeout(function() {
    loadEditorAndMoreBundlesGetDeferred().then(callback || _.noop)
  }, 0);
}


export function loadMoreScriptsBundle(callback?: () => Vo): Promise<Vo> {
  if (debiki.internal._showCreateUserDialog && !moreScriptsPromise) {
    // This means more-bundle was included in a <script> tag,
    // because _showCreateUserDialog() is in more-bundle.
    // Don't load more-bundle again — seems that'd clear e.g. `let loginDialog`
    // in namespace debiki2.login,  so the handle to any already
    // open login dialog would disappear — we couldn't close it.
    moreScriptsPromise = Promise.resolve();
  }
  if (moreScriptsPromise) {
    // Never call callback() immediately, because it's easier to write caller source code,
    // if one knows that callback() will never be invoked immediately.
    if (callback) setTimeout(() => moreScriptsPromise.then(callback), 0);
    return moreScriptsPromise;
  }
  moreScriptsPromise = new Promise<Vo>(function(resolve, reject) {
    // Also: [7PLBF20]
    loadJs(eds.assetUrlPrefix + 'more-bundle.' + eds.minMaxJs, function() {
      resolve();
      !callback || setTimeout(callback, 0);
    }, function() {
      moreScriptsPromise = null;
      reject();
    });
  });
  return moreScriptsPromise;
}


/*
export function load2dScriptsBundleStart2dStuff() {  // [2D_LAYOUT]
  die("2D layout disabled [TyE2DDISABLED]");
  if (hasStartedLoading2dScripts) {
    return;
  }
  hasStartedLoading2dScripts = true;
  loadJQuery(() => {
    loadJs(eds.assetUrlPrefix + '2d-bundle.' + eds.minMaxJs, function() {
      debiki.internal.layoutThreads();
      debiki2.utils.onMouseDetected(d.i.makeColumnsResizable);
      // Wrap in function, because not available until funtion evaluated (because then script loaded).
      debiki.internal.initUtterscrollAndTips();
    }, function() {
      hasStartedLoading2dScripts = false;
    });
  });
} */


export function loadStaffScriptsBundle(callback): Promise<Vo> {
  if (debiki2.admin && !staffScriptsPromise) {
    // This means staff-bundle was included in a <script> tag.
    staffScriptsPromise = Promise.resolve();
  }
  if (staffScriptsPromise) {
    // Never call callback() immediately, because it's easier to write caller source code,
    // if one knows that callback() will never be invoked immediately.
    setTimeout(() => staffScriptsPromise.then(callback), 0);
    return staffScriptsPromise;
  }
  staffScriptsPromise = new Promise<Vo>(function(resolve, reject) {
    // The staff scripts bundle requires both more-bundle.js and editor-bundle.js (to render
    // previews of CommonMark comments [7PKEW24]). This'll load them both.
    loadEditorAndMoreBundles(() => {
      loadJs(eds.assetUrlPrefix + 'staff-bundle.' + eds.minMaxJs, function() {
        resolve();
        callback();  // setTimeout(..., 0) not needed — done by loadMoreScriptsBundle() already
      }, function() {
        staffScriptsPromise = null;
        reject();
      });
    });
  });
  return staffScriptsPromise;
}


export function loadEditorAndMoreBundlesGetDeferred(): Promise<Vo> {
  if (editorScriptsPromise)
    return editorScriptsPromise;

  // Now we'll load FileAPI, and according to the docs it needs to know where it
  // can find its implementation details files (Flash and Html5 stuff depending on
  // browser html5 support). However, works anyway, without any staticPath. Hmm.
  window['FileAPI'] = {
    staticPath: '/-/tfEF357cw/', // later: '/-/res/', — but first actually place the files here
    debug: eds.isDev,
  };

  // The editor scripts bundle requires more-bundle.js, and jquery-bundle (At.js,
  // for @mention dropdowns). Load everything in parallel. This stuff is also prefetched,
  // if supported by the browser, see: [7PLBF20].
  const editorLoaded = loadJs(eds.assetUrlPrefix + 'editor-bundle.' + eds.minMaxJs);
  const moreScriptsLoaded = loadMoreScriptsBundle();

  const timeoutHandle = showWaitForRequestOverlay(true);
  // But don't resolve the editorScriptsPromise until everything has been loaded.
  editorScriptsPromise = new Promise<Vo>(function(resolve, reject) {
    moreScriptsLoaded.then(function() {
      editorLoaded.then(function() {
        removeWaitForRequestOverlay(timeoutHandle);
        resolve();
      }).catch(reject);
    }).catch(reject);
  }).catch(function() {
    editorScriptsPromise = null;
  });
  return editorScriptsPromise;
}


/* jQuery was needed in the past, for horizontal scrolling in 2D layout, [2D_LAYOUT]
   now disabled though.
function loadJQuery(callback?) {
  if (jQueryPromise) {
    // Never call callback() immediately, because it's easier to write caller source code,
    // if one knows that callback() will never be invoked immediately.
    !callback || setTimeout(() => jQueryPromise.then(callback), 0);
    return jQueryPromise;
  }
  jQueryPromise = new Promise(function(resolve) {
    // Also: [7PLBF20]
    loadJs(eds.assetUrlPrefix + 'jquery-bundle.' + eds.minMaxJs, function() {
      resolve();
      !callback || setTimeout(callback, 0);
    });
  });
  return jQueryPromise;
} */


export function createSite(localHostname: string,
    anyEmbeddingSiteAddress: string, organizationName: string,
    doneCallback: (string) => void) {
  const isTestSite = window.location.search.indexOf('testSiteOkDelete=true') !== -1 ||
    window.location.pathname === '/-/create-test-site';
  postJson('/-/create-site', {
    data: {
      acceptTermsAndPrivacy: true,
      localHostname: localHostname,
      embeddingSiteAddress: anyEmbeddingSiteAddress,
      organizationName: organizationName,
      testSiteOkDelete: isTestSite,
    },
    success: (response) => {
      doneCallback(response.nextUrl);
    }
  });
}


export function loadAdminDashboard(onDone: (_: AdminDashboard) => void) {
  get('/-/load-dashboard', onDone);
}



interface LoadSettingsResult {
  effectiveSettings: Settings;
  defaultSettings: Settings;
  baseDomain: string,
  dnsCnameTargetHost: string,
  hosts: Host[];
}


export function loadSiteSettings(success: (s: LoadSettingsResult) => void) {
  get('/-/load-site-settings', success);
}


export function saveSiteSettings(settings: Settings, success: (s: LoadSettingsResult) => void) {
  postJsonSuccess('/-/save-site-settings', success, settings);
}


export function changeHostname(newHostname: string, success: () => void) {
  postJsonSuccess('/-/change-hostname', success, { newHostname: newHostname });
}


export function redirectExtraHostnames(success: () => void) {
  postJsonSuccess('/-/update-extra-hostnames', success, { redirect: true });
}


export function stopRedirectingExtraHostnames(success: () => void) {
  postJsonSuccess('/-/update-extra-hostnames', success, { redirect: false });
}



export function loadIdentityProviders(onOk: (
        idps: IdentityProviderSecretConf[]) => Vo) {
  get('/-/load-oidc-config', onOk);
}


export function upsertIdentityProvider(idps: IdentityProviderSecretConf[],
        onOk: () => Vo, onError: (message: St) => Vo) {
  postJsonSuccess('/-/upsert-oidc-config', onOk, idps);
}


export function loadSpecialContent(rootPageId: string, contentId: string,
      doneCallback: (any) => void) {
  let url = '/-/load-special-content?rootPageId=' + (rootPageId ? rootPageId : '') +
      '&contentId=' + contentId;
  get(url, doneCallback);
}


export function saveSpecialContent(specialContent: SpecialContent, success: () => void) {
  const data: any = {
    rootPageId: specialContent.rootPageId,
    contentId: specialContent.contentId,
    useDefaultText: specialContent.anyCustomText === specialContent.defaultText
  };
  if (!data.useDefaultText) {
    data.anyCustomText = specialContent.anyCustomText;
  }
  postJsonSuccess('/-/save-special-content', success, data);
}


export function moderatePostOnPage(post, decision: ReviewDecision,
          onDone: (storePatch: StorePatch) => void) {
  const data = {
    postId: post.uniqueId,
    postRevNr: post.currRevNr,
    decision,
  };
  postJsonSuccess('/-/moderate-from-page', onDone, data);
}


export function loadReviewTasks(success: (tasks: ReviewTask[]) => void) {
  get('/-/load-review-tasks', response => handleReviewTasksResponse(response, success));
}


export function makeReviewDecision(taskId: number, revisionNr: number, decision: ReviewDecision,
      success: (tasks: ReviewTask[]) => void) {
  postJsonSuccess('/-/make-review-decision',
        response => handleReviewTasksResponse(response, success),
        { taskId, revisionNr, decision });
}


export function undoReviewDecision(taskId: number, success: (tasks: ReviewTask[]) => void) {
  postJsonSuccess('/-/undo-review-decision',
      response => handleReviewTasksResponse(response, success),
      { taskId });
}


function handleReviewTasksResponse(response, success) {
  const counts = response.reviewTaskCounts;
  const myselfPatch: MyselfPatch = {
    numUrgentReviewTasks: counts.numUrgent,
    numOtherReviewTasks: counts.numOther,
  };
  ReactActions.patchTheStore({
    usersBrief: response.users,
    pageMetasBrief: response.pageMetasBrief,
    me: myselfPatch,
  });
  success(response.reviewTasks);
}


export function createOauthUser(data, onDone: (response) => void,
      error: (failedRequest: HttpRequest) => ErrorPolicy) {
  // ([5028KTDN306]: This immediately remembers any weakSessionId, no need to do again.)
  postJsonSuccess(
      '/-/login-oauth-create-user', makeUpdNoCookiesTempSessionIdFn(onDone), error, data);
}


export function createPasswordUser(data, onDone: (response) => void,
      error: (failedRequest: HttpRequest) => ErrorPolicy) {
  postJsonSuccess(
      '/-/login-password-create-user', makeUpdNoCookiesTempSessionIdFn(onDone), error, data);
}


export function sendResetPasswordEmail(user: UserInclDetails, onOk: () => void) {
  postJsonSuccess('/-/send-reset-password-email', onOk, { toUserId: user.id });
}


export function loginWithPassword(emailOrUsername: string, password: string, onDone: () => void,
      onDenied: () => void, onPasswordMissing: () => void) {
  function onError(xhr?: XMLHttpRequest) {
    if (xhr) {
      if (xhr.responseText.indexOf(BadNameOrPasswordErrorCode) >= 0) {
        onDenied();
        return IgnoreThisError;
      }
      if (xhr.responseText.indexOf(NoPasswordErrorCode) >= 0) {
        onPasswordMissing();
        return IgnoreThisError;
      }
    }
  }
  postJsonSuccess('/-/login-password', makeUpdNoCookiesTempSessionIdFn(onDone), onError, {
    email: emailOrUsername,
    password: password,
  });
}


export function loginAsGuest(name: string, email: string,
      onDone: (response: AuthnResponse) => void, onError: () => void) {
  postJsonSuccess('/-/login-guest', makeUpdNoCookiesTempSessionIdFn(onDone), onError, {
    name: name,
    email: email
  });
}


export function loginWithOneTimeSecret(oneTimeLoginSecret: string,
    onDone: (weakSesionId: string) => void) {
  get(`/-/v0/login-with-secret?oneTimeSecret=${oneTimeLoginSecret}`,
      makeUpdNoCookiesTempSessionIdFn(onDone));
}


export function makeUpdNoCookiesTempSessionIdFn<R>(onDone: (response: R) => void) {
  return function(response) {
    // Update the current page session id, so we'll remember the current session  [NOCOOKIES]
    // until the page closes / reloads — so we stay logged in (until page closes) also if
    // we avoid cookies. Update also if the new value is `undefined` — should forget
    // any old session.
    // If we're in a login popup window opened from an embedded comments iframe, then we
    // should set the session id in the main embedded window, that is, the one with all comments.
    const mainWin = getMainWin();
    const typs: PageSession = mainWin.typs;
    typs.weakSessionId = response.weakSessionId;
    // We'll tell any other iframes that we logged in, via a 'justLoggedIn' message. [JLGDIN]
    if (onDone) {
      onDone(response);
    }
  };
}


export function logout(success: () => void) {
  // SECURITY COULD delete cookies and typs.weakSessionId also if server offline?
  const currentUrlPath = location.pathname.toString();
  postJsonSuccess(`/-/logout?currentUrlPath=${currentUrlPath}`, (response) => {
    const mainWin = getMainWin();
    const typs: PageSession = mainWin.typs;
    delete typs.weakSessionId;
    if (response.goToUrl && response.goToUrl !== currentUrlPath) {
      location.assign(response.goToUrl);  // [9UMD24]
      // Stop here, otherwise success() below might do location.reload(), which apparently
      // cancels location.assign(..).
      return;
    }
    if (success) {
      success();
    }
  }, null);
}


export function makeImpersonateAtOtherSiteUrl(siteId: SiteId, userId: UserId): string {
  return '/-/impersonate-at-other-site?siteId=' + siteId + '&userId=' + userId;
}


export function impersonateGoToHomepage(userId: UserId) {
  postJsonSuccess('/-/impersonate?userId=' + userId, () => {
    location.assign('/');
    // Don't: location.reload() — apparently that cancels assign(/) above.
  }, null);
}


export function viewAsOther(userId: UserId, success: () => void) {
  postJsonSuccess(`/-/view-as-other?userId=${userId}`, success, null);
}


export function stopImpersonatingReloadPage() {
  postJsonSuccess('/-/stop-impersonating', () => {
    location.reload();
  }, null);
}


export function loadGroups(onDone: (_: Group[]) => void) {
  get('/-/load-groups', onDone);
}


export function createGroup(newGroup: Group, onDone: (newGroup: Group) => void) {
  postJsonSuccess('/-/create-group', onDone, newGroup);
}


export function deleteGroup(groupIdToDelete: UserId, onDone: (deletedGroup: Group) => void) {
  postJsonSuccess('/-/delete-group', onDone, { groupIdToDelete });
}


export function listGroupMembers(groupId: UserId, onDone: (_: Participant[]) => void) {
  get(`/-/list-group-members?groupId=${groupId}`, onDone);
}


export function addGroupMembers(groupId: UserId, memberIds: UserId[], onDone: () => void) {
  postJsonSuccess('/-/add-group-members', r => onDone(), { groupId, memberIds });
}


export function removeGroupMembers(groupId: UserId, memberIds: UserId[], onDone: () => void) {
  postJsonSuccess('/-/remove-group-members', r => onDone(), { groupId, memberIds });
}


// BUG might get a Guest or Group, not always a UserInclDetails. SHOULD find for usages & fix.
// (Some callers, but not all, can deal with Group or Guest.)
export function loadUserAnyDetails(userIdOrUsername: UserId | string,
      onDone: (user: UserDetailsStatsGroups, groupsMaySee: Group[]) => void, error?: () => void) {
  get('/-/load-user-any-details?who=' + userIdOrUsername, (response) => {
    onDone(response.user, response.groupsMaySee);
  }, error);
}


export function listCompleteUsers(whichUsers, success: (users: UserInclDetailsWithStats[]) => void) {
  get(`/-/list-complete-users?whichUsers=${whichUsers}`, response => {
    success(response.users);
  });
}


type UserAcctRespHandler = (response: UserAccountResponse) => void;


export function loadEmailAddressesAndLoginMethods(userId: UserId, success: UserAcctRespHandler) {
  get(`/-/load-email-addrs-login-methods?userId=${userId}`, response => {
    success(response);
  });
}


export function resendOwnerEmailAddrVerifEmail(success) {
  postJsonSuccess('/-/resend-owner-email-addr-verif-email', success, {});
}


// Maybe initiated by staff, on behalf of another user — so could be any id and address.
//
export function resendEmailAddrVerifEmail(userId: UserId, emailAddress: string) {
  postJsonSuccess('/-/resend-email-addr-verif-email', (response: UserAccountResponse) => {
    morebundle.openDefaultStupidDialog({ body: "Email sent" });
  }, { userId, emailAddress });
}

export function addEmailAddresses(userId: UserId, emailAddress: string, success: UserAcctRespHandler) {
  postJsonSuccess('/-/add-email-address', success, { userId, emailAddress });
}


export function removeEmailAddresses(userId: UserId, emailAddress: string,
      success: UserAcctRespHandler) {
 postJsonSuccess('/-/remove-email-address', success, { userId, emailAddress });
}


export function setPrimaryEmailAddresses(userId: UserId, emailAddress: string,
      success: UserAcctRespHandler) {
  postJsonSuccess('/-/set-primary-email-address', success, { userId, emailAddress });
}


export function sendInvites(
      requestBody: SendInvitesRequestBody,
      onDone: (response: SendInvitesResponse) => void,
      onError: (failedRequest: HttpRequest) => ErrorPolicy) {
  postJsonSuccess('/-/send-invites', onDone, onError, requestBody);
}


export function loadInvitesSentBy(userId: UserId, success: (invites: Invite[]) => void,
        error: (message: string) => void) {
  get('/-/load-invites?sentById=' + userId, response => {
    ReactActions.patchTheStore({ usersBrief: response.users });
    success(response.invites);
  }, error);
}


export function loadAllInvites(success: (invites: Invite[]) => void) {
  get('/-/load-all-invites', response => {
    ReactActions.patchTheStore({ usersBrief: response.users });
    success(response.invites);
  });
}


export function editMember(userId: UserId, doWhat: EditMemberAction, success: () => void) {
  postJsonSuccess('/-/edit-member', success, { userId: userId, doWhat: doWhat });
}


export function suspendUser(userId: UserId, numDays: number, reason: string, success: () => void) {
  postJsonSuccess('/-/suspend-user', success, {
    userId: userId,
    numDays: numDays,
    reason: reason
  });
}


export function unsuspendUser(userId: UserId, success: () => void) {
  postJsonSuccess('/-/unsuspend-user', success, { userId: userId });
}


export function lockTrustLevel(userId: UserId, trustLevel: TrustLevel, success: () => void) {
  if (trustLevel) {
    postJsonSuccess('/-/lock-trust-level', () => {
      // ReactActions.patchTheStore();
      success();
    }, {
      userId: userId,
      trustLevel: trustLevel,
    });
  }
  else {
    postJsonSuccess('/-/unlock-trust-level', success, { userId: userId, });
  }
}


export function lockThreatLevel(userId: UserId, threatLevel: ThreatLevel, success: () => void) {
  if (threatLevel) {
    postJsonSuccess('/-/lock-threat-level', () => {
      // ReactActions.patchTheStore();
      success();
    }, {
      userId: userId,
      threatLevel: threatLevel,
    });
  }
  else {
    postJsonSuccess('/-/unlock-threat-level', success, { userId: userId, });
  }
}


export function savePageNotfPrefUpdStoreIfSelf(memberId: UserId, target: PageNotfPrefTarget,
      notfLevel: PageNotfLevel, onDone?: () => void) {
  const notfPref: PageNotfPref = { ...target, memberId, notfLevel };
  const postData: PageNotfPref & NewEmbCommentsPageIdCatUrl = notfPref;

  // If this is for an embedded comments page that hasn't yet been created, we should
  // also include any alt page id, and the embedding url. [4AMJX7]
  if (notfPref.pageId === EmptyPageId) {
    // COULD instead:
    // const serverVars = getMainWin().eds;
    postData.discussionId = eds.embeddedPageAltId || undefined;  // undef not ''
    postData.embeddingUrl = eds.embeddingUrl || undefined;
    postData.lazyCreatePageInCatId = eds.lazyCreatePageInCatId;
  }

  postJsonSuccess('/-/save-content-notf-pref', (response) => {
    if (response.newlyCreatedPageId) {
      // Update this, so subsequent server requests, will use the correct page id. [4HKW28]
      eds.embeddedPageId = response.newlyCreatedPageId;
    }

    // If one saved one's own prefs (rather than if one is staff, and changed someone
    // else's prefs), then, update store.me to reflect the changes.
    const store: Store = ReactStore.allData();
    const me: Myself = store.me;
    if (memberId === me.id) {
      let pageData: MyPageData = me.myDataByPageId[target.pageId];
      if (!pageData && response.newlyCreatedPageId) {
        // Add page data for the new page, so it's there if we need to e.g. render a
        // notf pref button title (then, need to know our page notf level) [TyT305MHRTDP23].
        // The id will remain EmptyPageId = '0', not newlyCreatedPageId, until page reload.
        pageData = makeNoPageData();
      }

      let newMe: Myself;
      if (pageData) {
        newMe = me_copyWithNewPageData(me, { ...pageData, myPageNotfPref: notfPref })
      }
      else {
        const updPrefs = pageNotfPrefs_copyWithUpdatedPref(me.myCatsTagsSiteNotfPrefs, notfPref);
        newMe = { ...me, myCatsTagsSiteNotfPrefs: updPrefs };
      }
      ReactActions.patchTheStore({ me: newMe });
    }
    if (onDone) {
      onDone();
    }
  }, postData);
}


export function loadMyself(callback: (user: any) => void) {
  // @ifdef DEBUG
  const mainWin = getMainWin();
  const typs: PageSession = mainWin.typs;
  if (!typs.canUseCookies && !typs.weakSessionId) {
    console.error(`Cannot load myself: No cookies, no mainWin.typs.weakSessionId. ` +
        `This frame name: ${window.name}, ` +
        `main frame name: ${mainWin.name}, ` +
        `this is main frame: ${window === mainWin}, ` +
        `mainWin.typs: ${JSON.stringify(typs)} [TyE603FKNFD5]`);
    debugger;
  }
  // @endif
  // SHOULD incl sort order & topic filter in the url params. [2KBLJ80]
  get(`/-/load-my-page-data?pageId=${getPageId()}`, callback);
}

export function listDrafts(userId: UserId,
      onOk: (response: ListDraftsResponse) => void, onError: () => void) {
  get(`/-/list-drafts?userId=${userId}`, onOk, onError);
}


export function loadNotifications(userId: UserId, upToWhenMs: number,
      success: (notfs: Notification[]) => void, error: () => void) {
  const query = '?userId=' + userId + '&upToWhenMs=' + upToWhenMs;
  get('/-/load-notifications' + query, success, error);
}


export function markNotfsRead() {
  postJsonSuccess('/-/mark-all-notfs-as-seen', (notfs) => {
    // Should be the same as [7KABR20], server side.
    const myselfPatch: MyselfPatch = {
      numTalkToMeNotfs: 0,
      numTalkToOthersNotfs: 0,
      numOtherNotfs: 0,
      thereAreMoreUnseenNotfs: false,
      notifications: notfs,
    };
    ReactActions.patchTheStore({ me: myselfPatch });
  }, null, {});
}


export function markNotificationAsSeen(notfId: number, onDone?: () => void, onError?: () => void) {
  postJsonSuccess('/-/mark-notf-as-seen', onDone, onError, { notfId });
}


export function snoozeNotfs(untilMins: number | false, onDone?: () => void) {
  postJsonSuccess('/-/snooze-notfs', onDone, { untilMins });
}


/*
export function setTagNotfLevel(tagLabel: TagLabel, newNotfLevel: PageNotfLevel) {
  postJsonSuccess('/-/set-tag-notf-level', () => {
    const store: Store = ReactStore.allData();
    const newLevels = _.clone(store.tagsStuff.myTagNotfLevels);
    newLevels[tagLabel] = newNotfLevel;
    ReactActions.patchTheStore({
      tagsStuff: { myTagNotfLevels: newLevels }
    });
  }, {
    tagLabel: tagLabel,
    notfLevel: newNotfLevel
  });
} */


export function saveAboutPatPrefs(prefs, isGroup: Bo, onOk: (_: PatVb) => Vo) {
  // CLEAN_UP merge into the same endpoint:  save-about-prefs
  const url = isGroup ? '/-/save-about-group-prefs' : '/-/save-about-member-prefs';
  postJsonSuccess(url, onOk, prefs);
}


export function savePatPerms(patId: PatId, perms: GroupPerms, onOk: () => Vo) {
  postJsonSuccess('/-/save-pat-perms', onOk, { patId, ...perms });
}


export function saveUiPrefs(memberId: UserId, prefs, onDone: () => void) {
  postJsonSuccess('/-/save-ui-prefs', onDone, { memberId, prefs });
}


export function loadCatsTagsSiteNotfPrefs(memberId: UserId,
      onDone: (response: PageNotfPrefsResponse) => void) {
  get(`/-/load-cats-tags-site-notf-prefs?memberId=${memberId}`, onDone);
}


export function saveMemberPrivacyPrefs(prefs, success: () => void) {
 postJsonSuccess(`/-/save-privacy-prefs`, success, prefs);
}


export function deleteUser(userId, success: (anonUsername: string) => void) {
  postJsonSuccess(`/-/delete-user`, success, { userId });
}


export function saveGuest(guest, success: () => void) {
  postJsonSuccess('/-/save-guest', success, guest);
}


export function blockGuest(postId: PostId, numDays: number, threatLevel: ThreatLevel,
      success: () => void) {
  postJsonSuccess('/-/block-guest', success, {
    postId: postId,
    numDays: numDays,
    threatLevel: threatLevel,
  });
}


export function unblockGuest(postId: number, success: () => void) {
  postJsonSuccess('/-/unblock-guest', success, { postId: postId });
}


export function loadAuthorBlockedInfo(postId: number, success: (response: Blocks) => void) {
  get('/-/load-author-blocks?postId=' + postId, success);
}


export function createForum(options: { title, folder, useCategories, createSupportCategory,
      createIdeasCategory, createSampleTopics, topicListStyle }, success: () => void) {
  postJsonSuccess('/-/create-forum', success, options);
}


export function listForums(success: (forums: Forum[]) => void) {
  get('/-/list-forums', success);
}


export function createEmbCmtsSiteGoToInstrs() {
  postJsonSuccess('/-/create-embedded-comments-site',
    () => location.assign('/-/admin/settings/embedded-comments'), {});
}


export function loadForumCategoriesTopics(forumPageId: string, topicFilter: string,
      success: (categories: Category[]) => void) {
  let url = '/-/list-categories-topics?forumId=' + forumPageId;
  if (topicFilter) {
    url += '&filter=' + topicFilter;
  }
  get(url, success);
}


export function loadForumTopics(categoryId: string, orderOffset: OrderOffset,
    doneCallback: (response: LoadTopicsResponse) => void) {
  const url = '/-/list-topics?categoryId=' + categoryId + '&' +
      ServerApi.makeForumTopicsQueryParams(orderOffset);
  get(url, (response: LoadTopicsResponse) => {
    ReactActions.patchTheStore({ usersBrief: response.users });  // [2WKB04R]
    doneCallback(response);
  });
}


export function loadTopicsByUser(userId: UserId,
        doneCallback: (topics: Topic[]) => void) {
  const url = `/-/list-topics-by-user?userId=${userId}`;
  get(url, (response: any) => {
    ReactActions.patchTheStore({ usersBrief: response.users });
    doneCallback(response.topics);
  });
}


export function listAllUsernames(prefix: string, doneCallback: (usernames: BriefUser) => void) {
  const url = '/-/list-all-users?usernamePrefix='+ prefix;
  get(url, doneCallback);
}


export function listUsernames(prefix: string, pageId: PageId, success: (usernames: BriefUser) => void) {
  let url = `/-/list-usernames?pageId=${pageId}&prefix=${prefix}`;
  get(url, success);
}


// Currently doesn't load any draft.
// Later: add reply-to-post-unique-id, to load the correct draft?  [idnotnr]
//
export function loadDraftAndGuidelines(draftLocator: DraftLocator, writingWhat: WritingWhat,
      categoryId: number, pageRole: PageRole,
      success: (guidelinesSafeHtml: string | U, draft?: Draft) => void) {

  // For now, we don't save drafts for not-yet-lazy-created pages.
  // (Instead, such drafts currently stored in the browser only.)
  // And such pages tend to have no guidelines.
  if (pageRole === PageRole.EmbeddedComments && !draftLocator?.pageId) {
    success(undefined);
    return;
  }

  const loc = draftLocator;
  const draftTypeParam = '&draftType=' + loc.draftType;
  const pageIdParam = loc.pageId ? '&pageId=' + loc.pageId : '';
  const postNrParam = loc.postNr ? '&postNr=' + loc.postNr : '';
  const postIdParam = loc.postId ? '&postId=' + loc.postId : '';
  const toUserIdParam = loc.toUserId ? '&toUserId=' + loc.toUserId : '';
  const categoryParam = categoryId ? '&categoryId=' + categoryId : '';

  const url = `/-/load-draft-and-guidelines?writingWhat=${writingWhat}&pageRole=${pageRole}` +
    draftTypeParam + pageIdParam + postNrParam + postIdParam + toUserIdParam + categoryParam;

  get(url, (response) => {
    success(response.guidelinesSafeHtml, response.drafts[0]); // for now, just pick the first
  });
}


export function loadDraftAndText(postNr: PostNr,
      onDone: (response: LoadDraftAndTextResponse) => void) {
  get(`/-/load-draft-and-text?pageId=${getPageId()}&postNr=${postNr}`, onDone, undefined, {
    // If takes a second to load the post text (because of high latency),
    // it's nice to see that one's Edit button click did cause something to happen
    // — and also, good to instantly disable everything (by adding this click
    // catching overlay), so the user won't continue clicking other buttons, e.g. Reply,
    // whilst this request is in flight.
    showLoadingOverlay: true,
  });
}


export function upsertDraft(draft: Draft, onOk: ((draftWithNr: Draft) => void) | UseBeacon,
      onError: ErrorStatusHandler | undefined) {
  postJsonSuccess('/-/upsert-draft', onOk, draft, function(xhr) {
    onError(xhr.status);
    return ShowNoErrorDialog;
  }, { showLoadingOverlay: false });
}


export function deleteDrafts(draftNrs: DraftNr[], onOk: (() => void) | UseBeacon,
        onError?: ErrorStatusHandler) {
  postJsonSuccess('/-/delete-drafts', onOk, draftNrs, function(xhr) {
    if (onError) onError(xhr.status);
    return ShowNoErrorDialog;
  }, { showLoadingOverlay: false });
}


const cachedLinkPreviewHtml: { [url: string]: LinkPreviewResp } = {};


export function fetchLinkPreview(url: St, inline: Bo, /* later: curPageId: PageId, */
        onOk: (resp: LinkPreviewResp | Nl) => Vo) {
  const curPageId = '123'; // whatever, for now
  // People often accidentally append spaces, so trim spaces.
  // But where's a good palce to trim spaces? The caller or here? Here, for now.
  url = url.trim();

  const cachedHtml = cachedLinkPreviewHtml[url];
  if (isDefined2(cachedHtml)) {
    setTimeout(() => onOk(cachedHtml), 0);
    return;
  }
  const encodedUrl = encodeURIComponent(url);
  get(`/-/fetch-link-preview?url=${encodedUrl}&curPageId=${curPageId}&inline=${inline}`,
        (resp: LinkPreviewResp) => {
    // Later: Return '' instead if no preview available? So won't be lots of
    // annoying 40X "failed" requests in the dev tools console.
    cachedLinkPreviewHtml[url] = resp;
    onOk(resp);
  }, function() {
    cachedLinkPreviewHtml[url] = null;
    // Pass null to tell the editor to show no link preview (and just show a plain link).
    onOk(null);
    // It'd be annoying if error dialogs popped up, whilst typing.
    return IgnoreThisError;
  });
}


export function saveVote(data: {
    pageId: PageId,
    postNr: PostNr,
    vote: string,
    action: 'DeleteVote' | 'CreateVote',
    postNrsRead: PostNr[]
}, onDone: (updatedPost) => void) {
  // Specify altPageId and embeddingUrl, so any embedded page can be created lazily. [4AMJX7]
  // @ifdef DEBUG
  dieIf(data.pageId && data.pageId !== EmptyPageId && data.pageId !== getPageId(), 'TyE2ABKSY7');
  // @endif
  const dataWithEmbeddingUrl = {
    ...data,
    pageId: getPageId() || undefined,
    discussionId: eds.embeddedPageAltId || undefined,  // undef not ''
    embeddingUrl: eds.embeddingUrl || undefined,
    lazyCreatePageInCatId: eds.lazyCreatePageInCatId,
  }
  postJsonSuccess('/-/vote', (response) => {
    if (response.newlyCreatedPageId) {
      // Update this, so subsequent server requests, will use the correct page id. [4HKW28]
      eds.embeddedPageId = response.newlyCreatedPageId;
    }
    onDone(response.updatedPost);
  }, dataWithEmbeddingUrl);
}


export function loadVoters(postId: PostId, voteType: PostVoteType,
      doneCallback: (numVoters: number, someVoters: BriefUser[]) => void) {
 get('/-/load-voters?postId='+ postId + '&voteType=' + voteType, (response: any) => {
   doneCallback(response.numVoters, response.someVoters);
 });
}


export function saveEdits(editorsPageId: PageId, postNr: number, text: string,
      deleteDraftNr: DraftNr, doneCallback: () => void) {
  postJson('/-/edit', {
    data: {
      pageId: editorsPageId ||
          // Old (as of Jan 2020), keep for a while?:
          getPageId(),
      postNr: postNr,
      text: text,
      deleteDraftNr,
    },
    success: (editedPost) => {
      // This hides the editor and places back the orig post [6027TKWAPJ5]
      // — there'll be a short flash-of-original-version:
      doneCallback();
      // ... until here we upsert the edited version instead:
      ReactActions.handleEditResult(editedPost);
    }
  });
}


export function savePageTitleAndSettings(settings: EditPageRequestData,
      success: (response: EditPageResponse) => void, onError: () => void) {
  const data = {
    ...settings,
    pageId: getPageId(),
  };
  postJson('/-/edit-title-save-settings', {
    data: data,
    success: (response: EditPageResponse) => {
      success(response);
      if (response.newUrlPath && window.history.replaceState) {
        const newPath = response.newUrlPath + location.search + location.hash;
        window.history.replaceState({}, null, newPath);
      }
    },
    error: onError
  });
}


export function loadLatestPostRevisions(postId: PostId,
    success: (revisions: PostRevision[]) => void) {
  get('/-/load-post-revisions?postId=' + postId + '&revisionNr=LastRevision', success);
}


/** Loads revision revisionNr and some older revisions.
  */
export function loadMorePostRevisions(postId: PostId, revisionNr: number,
    success: (revisions: PostRevision[]) => void) {
  get('/-/load-post-revisions?postId=' + postId + '&revisionNr=' + revisionNr, success);
}


export function pinPage(pinWhere: PinPageWhere, pinOrder: number, success: () => void) {
  postJsonSuccess('/-/pin-page', success, {
    pageId: getPageId(),
    pinWhere: pinWhere,
    pinOrder: pinOrder,
  });
}


export function unpinPage(success: () => void) {
  postJsonSuccess('/-/unpin-page', success, { pageId: getPageId() });
}


export function saveReply(editorsPageId: PageId, postNrs: PostNr[], text: string,
      anyPostType: number, deleteDraftNr: DraftNr | undefined,
      success: (storePatch: StorePatch) => void) {
  postJson('/-/reply', {
    data: {
      pageId: editorsPageId ||
          // Old (as of Jan 2020), keep for a while?:
          getPageId() || undefined,
      // Incl altPageId and embeddingUrl, so any embedded page can be created lazily. [4AMJX7]
      discussionId: eds.embeddedPageAltId || undefined,  // undef not ''
      embeddingUrl: eds.embeddingUrl || undefined,
      lazyCreatePageInCatId: eds.lazyCreatePageInCatId,
      postNrs: postNrs,
      postType: anyPostType || PostType.Normal,
      text: text,
      deleteDraftNr,
    },
    success
  });
}


export function insertChatMessage(text: string, deleteDraftNr: DraftNr | undefined,
      success: (storePatch: StorePatch) => void) {
  postJson('/-/chat', {
    data: {
      pageId: getPageId(),
      text: text,
      deleteDraftNr,
    },
    success
  });
}


export function addUsersToPage(userIds: UserId[], success) {
  postJsonSuccess('/-/add-users-to-page', () => {
    // Send new store data in the reply? [5FKE0WY2]
    success();
  }, { pageId: getPageId(), userIds: userIds });
}


export function removeUsersFromPage(userIds: UserId[], success) {
  postJsonSuccess('/-/remove-users-from-page', () => {
    // Send new store data in the reply? [5FKE0WY2]
    success();
  }, { pageId: getPageId(), userIds: userIds });
}


export function joinPage(pageId?: PageId, onDone?) {
  if (_.isFunction(pageId)) {
    onDone = pageId;
  }
  postJsonSuccess('/-/join-page', (newWatchbar) => {
    if (newWatchbar) {
      ReactActions.setWatchbar(newWatchbar);
    }
    if (!pageId) {
      ReactActions.addMeAsPageMember();
    }
    // else: Will load users, when loading page.
    if (onDone) {
      onDone();
    }
  }, { pageId: pageId || getPageId() });
}


export function leavePage() {
  postJsonSuccess('/-/leave-page', (newWatchbar) => {
    if (newWatchbar) {
      ReactActions.setWatchbar(newWatchbar);
    }
    ReactActions.removeMeAsPageMember();
  }, { pageId: getPageId() });
}


export function configWatchbar(ps: { removePageIdFromRecent: PageId },
      onDone: (wb: Watchbar) => void) {
  postJsonSuccess('/-/config-watchbar', onDone, ps);
}


export function startPrivateGroupTalk(title: string, text: string, pageRole: PageRole,
    userIds: number[], deleteDraftNr: DraftNr, success: (pageId: PageId) => void) {
  postJsonSuccess('/-/start-private-group-talk', success,
      { title: title, text: text, pageRole: pageRole, userIds: userIds, deleteDraftNr });
}


export function submitCustomFormAsJsonReply(entries: object[], success?: () => void) {
  postJsonSuccess('/-/submit-custom-form-as-json-reply', success, {
    pageId: getPageId(),
    formInputs: entries,
  });
}


function getInputValueOrDie(inpName: string, formData: FormData): string {
  let concatenatedValues = null;
  const values: FormDataEntryValue[] = formData.getAll(inpName);
  for (let i = 0; i < values.length; ++i) {
    const valueUntrimmed = values[i];
    let value = valueUntrimmed.toString().trim();
    value = value.replace(/\\n/g, '\n');
    concatenatedValues = (concatenatedValues || '') + value;
  }
  dieIf(concatenatedValues === null, `Input missing: ${inpName} [EdE4WKFE02]`);
  return concatenatedValues.trim();
}


export function submitCustomFormAsNewTopic(formData: FormData) {
  die('untested [EdE2WKP05YU10]');
  function goToNewPage(response) {
    location.assign(linkToPageId(response.newPageId));
  }
  postJsonSuccess('/-/submit-custom-form-as-new-topic', goToNewPage, {
    newTopicTitle: getInputValueOrDie('title', formData),
    newTopicBody: getInputValueOrDie('body', formData),
    pageTypeId: getInputValueOrDie('pageTypeId', formData),
    categorySlug: getInputValueOrDie('categorySlug', formData),
  });
}


export function submitUsabilityTestingRequest(formData: FormData) {  // [plugin]
  const nextUrl = getInputValueOrDie('nextUrl', formData);
  function goToNewPage(response) {
    location.assign(nextUrl);
  }
  postJsonSuccess('/-/submit-usability-testing-form', goToNewPage, {
    websiteAddress: getInputValueOrDie('websiteAddress', formData),
    instructionsToTester: getInputValueOrDie('instructionsToTester', formData),
    pageTypeId: getInputValueOrDie('pageTypeId', formData),
    categorySlug: getInputValueOrDie('categorySlug', formData),
  });
}


export function loadPostByNr(postNr: PostNr, success: (patch: StorePatch) => void) {
  get(`/-/load-post?pageId=${getPageId()}&postNr=${postNr}`, success,
      (errorDetails: string, satus: number) => {
    let e2eTestClass: string;
    let message: string;
    if (errorDetails.indexOf('_TyEPOSTGONE_') >= 0) {
      // Post deleted, and it's ok to tell the requester about this.
      e2eTestClass = 'e_PDd';
      message = t.PostDeleted(postNr);
    }
    else if (errorDetails.indexOf('_TyEBADPOSTNR') >= 0) {
      // No post with that nr, and it's ok to tell the requester about this.
      e2eTestClass = 'e_BadPNr';
      message = t.NoSuchPost(postNr) + ' [TyEPOSTNR]';
    }
    else {
      // Show error dialog — don't return IgnoreThisError below.
      return;
    }

    // UX COULD remove any notf from theStore, so any blue MyMenu notf dot, disappears
    // directly. Because we can get to here, by clicking a MyMenu notf about a post
    // that was just deleted. — Doesn't matter much; such a notf will be gone anyway,
    // after page reload (filtered out here [SKIPDDNTFS]).

    morebundle.openDefaultStupidDialog({ body: message, dialogClassName: e2eTestClass });
    return IgnoreThisError;
  });
}


export function loadPostsByAuthor(authorId: UserId, success: (response) => void) {
  get(`/-/list-posts?authorId=${authorId}`, success);
}


export function makeDownloadMyContentUrl(authorId: UserId) {
  return `/-/download-my-content?authorId=${authorId}`;
}

export function makeDownloadPersonalDataUrl(authorId: UserId) {
  return `/-/download-personal-data?userId=${authorId}`;
}


export function flagPost(postNr: string, flagType: string, reason: string, success: () => void) {
  postJsonSuccess('/-/flag', (storePatch: StorePatch) => {
    ReactActions.patchTheStore(storePatch);
    if (success) success();
  }, {
    pageId: getPageId(),
    postNr: postNr,
    type: flagType,
    reason: reason
  });
}


export function hidePostInPage(postNr: number, hide: boolean, success: (postAfter: Post) => void) {
  postJsonSuccess('/-/hide-post', success, { pageId: getPageId(), postNr: postNr, hide: hide });
}


export function deletePostInPage(postNr: number, repliesToo: boolean,
      success: (deletedPost) => void) {
  postJsonSuccess('/-/delete-post', success, {
    pageId: getPageId(),
    postNr: postNr,
    repliesToo: repliesToo,
  });
}


export function editPostSettings(postId: PostId, settings: PostSettings) {
  const data = _.assign({ postId: postId }, settings);
  postJsonSuccess('/-/edit-post-settings', ReactActions.patchTheStore, data);
}


export function loadAllTags(success: (tags: string[]) => void) {
  get('/-/load-all-tags', success);
}


export function loadTagsAndStats() {
  get('/-/load-tags-and-stats', r => ReactActions.patchTheStore(r));
}


export function loadMyTagNotfLevels() {
  get('/-/load-my-tag-notf-levels', r => ReactActions.patchTheStore(r));
}


export function addRemovePostTags(postId: PostId, tags: string[], success: () => void) {
  postJsonSuccess('/-/add-remove-tags', (response) => {
    ReactActions.patchTheStore(response);
    success();
  }, {
    pageId: getPageId(),
    postId: postId,
    tags: tags
  });
}


export function changePostType(postNr: number, newType: PostType, success: () => void) {
  postJsonSuccess('/-/change-post-type', success, {
    pageId: getPageId(),
    postNr: postNr,
    newType: newType,
  });
}


export function movePost(postId: PostId, newHost: SiteId, newPageId: PageId,
      newParentNr: PostNr, success: (post: Post) => void) {
  postJsonSuccess('/-/move-post', (patch: StorePatch) => {
    ReactActions.patchTheStore(patch);
    const post = _.values(patch.postsByPageId)[0][0];
    dieIf(!post, 'EsE7YKGW2');
    success(post);
  }, {
    pageId: getPageId(),
    postId: postId,
    newHost: newHost,
    newPageId: newPageId,
    newParentNr: newParentNr,
  });
}


export function saveCategory(category: CategoryPatch, permissions: PermsOnPage[],
      success: (response: SaveCategoryResponse) => void, error?: () => void) {
  const data = {
    category: category,
    permissions: permissions,
  };
  postJsonSuccess('/-/save-category', success, data, error);
}


export function deleteCategory(categoryId: number, success: (StorePatch: any) => void,
      error?: () => void) {
  postJsonSuccess('/-/delete-category', success, error, { categoryId: categoryId });
}


export function undeleteCategory(categoryId: number, success: (StorePatch: any) => void,
      error?: () => void) {
  postJsonSuccess('/-/undelete-category', success, error, { categoryId: categoryId });
}


export function loadCategory(id: number, success: (response: LoadCategoryResponse) => void) {
  get('/-/load-category?id=' + id, success);
}


export function listCategoriesAllSections(success: (response: Category[]) => void)  {
  get('/-/list-categories-all-sections', success);
}


export function createPage(data, success: (newPageId: string) => void) {
  // [DRAFTS_BUG] This doesn't delete the draft? (if any)
  postJson('/-/create-page', {
    data: data,
    success: (response) => {
      success(response.newPageId);
    }
  });
}


export function loadPageIdsUrls(pageId: PageId | null,
      onDone: (response: LoadPageIdsUrlsResponse) => void) {
  const queryParams = pageId ? 'pageId=' + pageId : '';
  get(`/-/list-page-ids-urls?${queryParams}`, onDone);
}


export function savePageIdsUrls(data: PageIdsUrls, onDone: () => void) {
  postJsonSuccess('/-/save-page-ids-urls', onDone, data);
}


export function loadPageJson(path: string, success: (response) => void) {
  logM(`Loading page: ${path} [TyMLDPG]`);
  get(path + '?json', response => {
    logM(`Done loading ${path}, updating store...`);
    success(response);
    logM(`Done updating store.`);
  });
}


export function acceptAnswer(postId: number, success: (answeredAtMs: number) => void) {
  postJsonSuccess('/-/accept-answer', success, { pageId: getPageId(), postId: postId });
}


export function unacceptAnswer(success: () => void) {
  postJsonSuccess('/-/unaccept-answer', success, { pageId: getPageId() });
}

export function togglePageClosed(success: (closedAtMs: number) => void) {
  postJsonSuccess('/-/toggle-page-closed', success, { pageId: getPageId() });
}

export function deletePages(pageIds: PageId[], success: () => void) {
  postJsonSuccess('/-/delete-pages', success, { pageIds: pageIds });
}

export function undeletePages(pageIds: PageId[], success: () => void) {
  postJsonSuccess('/-/undelete-pages', success, { pageIds: pageIds });
}



const inFlightPageIds = new Set<PageId>();
let lastPageIdMarkedSeen: PageId;

// This updates the most recently visited pages in the watchbar (stored server side).
// And maybe more things, later, e.g. update user presence in a chat channel.
//
export function markCurrentPageAsSeen() {
  const pageId = getPageId();

  // You can show the annoying loading indicator by commenting in this:
  // (This was a bug, now e2e tested here:  TyT40PKDRT4)
  //postJsonSuccess(`/-/mark-as-seen?pageId=${pageId}`, () => {}, {});

  if (lastPageIdMarkedSeen === pageId || inFlightPageIds.has(pageId))
    return;

  inFlightPageIds.add(pageId);
  postJsonSuccess(`/-/mark-as-seen?pageId=${pageId}`, onComplete, onComplete, {},
      { showLoadingOverlay: false });

  function onComplete() {
    lastPageIdMarkedSeen = pageId;
    inFlightPageIds.delete(pageId);
  }
}


export function listApiSecrets(onOk: (secrets: ApiSecret[]) => void) {
  get('/-/list-api-secrets', onOk);
}


export function createApiSecret(onOk: (secret: ApiSecret) => void) {
  postJsonSuccess('/-/create-api-secret', onOk, {
    forAnyUser: true,
  });
}


export function deleteApiSecrets(secretNrs: ApiSecretNr[], onOk: () => void) {
  postJsonSuccess('/-/delete-api-secrets', onOk, { secretNrs });
}


export function search(rawQuery: string, success: (results: SearchResults) => void,
    onError?: () => void, opts?: { showLoadingOverlay?: false }) {
  postJsonSuccess('/-/search', success, { rawQuery: rawQuery }, onError, opts);
}


// COULD send via WebSocket instead [VIAWS].
// Uses navigator.sendBeacon if the `success` isn't specified.
export function trackReadingProgress(lastViewedPostNr: PostNr, secondsReading: number,
      postsRead: Post[], anyOnDone?: () => void) {
  if (eds.mainWorkUntilSecs)
    return;

  const pageId = getPageId();
  if (pageId === EmptyPageId)
    return;

  const pagePostNrIdsRead: PagePostNrId[] = postsRead.map(post => {
    return { pageId, postNr: post.nr, postId: post.uniqueId }
  });

  let nowMsUtc = Date.now(); // now() returns UTC
  let data = {
    pageId,
    visitStartedAt: nowMsUtc,
    lastViewedPostNr: lastViewedPostNr,
    lastReadAt: secondsReading > 0 ? nowMsUtc : null,
    secondsReading: secondsReading,
    pagePostNrIdsRead,
  };
  const onDone = !anyOnDone? UseBeacon : function(me?: MyselfPatch) {
    // See [7KABR20] server side.
    if (me) {
      ReactActions.patchTheStore({ me });
    }
    anyOnDone();
  };
  postJsonSuccess('/-/track-reading', onDone, data,
        // Don't popup any error dialog from here. If there's a network error, we'll show a
        // "No internet" non-intrusive message instead [NOINETMSG].
        () => ShowNoErrorDialog, { showLoadingOverlay: false });
}


export function markTourTipsSeen(tourTipsId: string) {
  postJsonSuccess('/-/mark-tour-tips-seen', function() {}, { tourTipsId },
        () => ShowNoErrorDialog, { showLoadingOverlay: false }); // [NOINETMSG]
}


export function loadOnlineUsers() {
  get('/-/load-online-users', (response) => {
    ReactActions.updateOnlineUsersLists(response.numOnlineStrangers, response.onlineUsers);
  });
}


export function listSites() {
  get('/-/list-sites', (patch) => {
    ReactActions.patchTheStore(patch);
  });
}


export function updateSites(sites: SASite[]) {
  postJsonSuccess('/-/update-sites', (patch) => {
    ReactActions.patchTheStore(patch);
  }, sites);
}


let pendingErrors = [];

export function logError(errorMessage: string) {
  pendingErrors.push(errorMessage);
  postPendingErrorsThrottled();
}


const postPendingErrorsThrottled = _.throttle(function() {
  if (!pendingErrors.length)
    return;
  postJsonSuccess('/-/log-browser-errors', () => {}, pendingErrors, null, { showLoadingOverlay: false });
  pendingErrors = [];
}, 5000);

// Will this work? Doesn't seem to work. Why not? Oh well.
window.addEventListener('unload', postPendingErrorsThrottled.flush);


//------------------------------------------------------------------------------
   }
//------------------------------------------------------------------------------
// vim: fdm=marker et ts=2 sw=2 tw=0 list
