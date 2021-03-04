local http = require "lua-resty-http/lib/resty.http"
-- Docs: https://github.com/ledgetech/lua-resty-http

-- Tests: upload-images-and-files.test.ts  TyT50E6KTDU7.TyTE2ESVUPLCK


local content_length = ngx.var.content_length
local host = ngx.var.host
local remote_addr = ngx.var.remote_addr

local httpc = http.new()

-- Timeouts: connect, send and read (in millis) — a second or more,
-- in case the JVM collects garbage or sth like that.
-- COULD: Many minutes read timeout, in dev mode, so time for a human
-- to step through the Scala app in a debugger.
httpc:set_timeouts(1000, 5000, 5000)

-- There's a connection pool; matching idle connections will get reused.
-- (For this to work, Nginx needs to have been configured with
-- `resolver dns-server-addr` — see nginx.conf — otherwise there'll be
-- this error:  'error: no resolver defined to resolve "app"')
httpc:connect("app", 9000)


-- COULD parse the request body and split at the form-data boundaries,
-- to find out how large each file is, in case there're many uploads in
-- the same request.  And to check mime types and file extensions [pre_chk_upl_ext].
-- See: https://www.gakhov.com/articles/
--          implementing-api-based-fileserver-with-nginx-and-lua.html
--
-- There's this Lua module: lua_resty_upload, which can parse form-data
-- and detect the sizes of the individual files.
--
--
-- COULD calculate Sha256 hashes of these individual files, and ask the
-- server if they've been saved already, server side, and then skip uploading
-- those files (just adding the <a href=...> links).
-- See: https://stackoverflow.com/questions/13981832/
--          how-do-i-use-sha256-on-a-filebinary-file-such-as-images-in-javascript
--
local res, err = httpc:request({
    path = "/-/_int_req/may-upload-file",
    query = "sizeBytes=" .. content_length,
    headers = {
        ['Host'] = host,  -- [ngx_host_hdr]
        -- Sometimes cookies won't work (e.g. from inside embedded comments iframes,
        -- because of browser anti-tracking features). Then we use X-Ty- headers instead.
        ['Cookie'] = ngx.var.http_cookie,
        ['X-Ty-Avoid-Cookies'] = ngx.var.http_x_ty_avoid_cookies,
        ['X-Ty-Sid'] = ngx.var.http_x_ty_sid,
        ['X-Ty-Xsrf'] = ngx.var.http_x_ty_xsrf,
        ['X-XSRF-TOKEN'] = ngx.var.http_x_xsrf_token,
        ['X-Request-Id'] = ngx.var.request_id,
        ['X-Forwarded-For'] = ngx.var.proxy_add_x_forwarded_for,
    },
})


local toFromSize =
        "to: " .. host ..
        " from: " .. remote_addr ..
        " size: " .. content_length

if not res then
    ngx.status = 500
    ngx.header.content_type = 'text/plain'
    ngx.say("500 Internal Error\n\n" ..
            "Error finding out if may upload file [TyELUAUPLCK]\n\n", err)
    ngx.log(ngx.ERR, "Request failed: /-/may-upload-file, " ..
            "rejecting upload " .. toFromSize .. " [TyELUAUPLCK]" ..
            ": 500 Internal Error [TyELUAUPLCK]: " .. err)
    return ngx.exit(ngx.HTTP_OK)
end

if res.status ~= 200 then
    ngx.status = res.status
    ngx.header.content_type = 'text/plain'
    ngx.say(res:read_body())
    ngx.log(ngx.DEBUG, "Rejecting upload " .. toFromSize ..
            " [TyMLUAREJUPL], status: " .. res.status)
    return ngx.exit(ngx.HTTP_OK)
end

ngx.log(ngx.DEBUG, "Allowing upload " .. toFromSize .. " [TyMALWUPL]")

