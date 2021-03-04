/**
 * Copyright (C) 2011-2017 Kaj Magnus Lindberg
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

package ed.server.security

import com.debiki.core._
import com.debiki.core.isDevOrTest
import com.debiki.core.Prelude._
import debiki.{AllSettings, EdHttp, EffectiveSettings, Globals}
import ed.server.http.{DebikiRequest, JsonOrFormDataBody}
import play.api.mvc.{Cookie, DiscardingCookie, RequestHeader}
import scala.util.Try
import EdSecurity._
import ed.server.auth.MayMaybe
import play.api.http.{HeaderNames => p_HNs}
import talkyard.server.TyLogger


sealed abstract class XsrfStatus { def isOk = false }
case object XsrfExpired extends XsrfStatus
case object XsrfBad extends XsrfStatus
case object XsrfBadEmpty extends XsrfStatus
case class XsrfOk(value: String) extends XsrfStatus {
  override def isOk = true
  def unixSeconds: Long = {
    dieIf(!value.contains('.'), "TyE2ABK49Z3", value)
    value.takeWhile(_ != '.').toLong
  }
}


// RENAME to AuthnMethod,
// and AuthnMethod.ApiSecret [5BKRH02], SidOk –> SessionId, None, BadSessionIdFormat, BadSessionIdHash?
sealed abstract class SidStatus {
  def canUse = false
  def userId: Option[UserId] = None
}

case object SidAbsent extends SidStatus {
  // It's ok to do a request as a not-logged-in someone, without a session id.
  override def canUse = true
}

case object SidBadFormat extends SidStatus
case object SidBadHash extends SidStatus
case class SidExpired(minutesOld: Long, maxAgeMins: Long) extends SidStatus


case class SidOk(
  value: String,
  ageInMillis: Long,
  override val userId: Option[UserId]) extends SidStatus {

  override def canUse = true
}


/** The value of Debiki's browser id cookie, which is used e.g. to count unique page
  * visits and to mitigate vote fraud.
  * @param isNew The cookie was just set, this very HTTP request, which means
  *              it's possible that the browser has disabled cookies?
  */
case class BrowserId(cookieValue: String, isNew: Boolean)


object EdSecurity {

  /** Tracker blockers and iOS and security settings, might block cookies [NOCOOKIES],
    * might break embedded comments. So we sometimes send back headers instead, and remember
    * client side, for the current page view only.
    *
    * This header tells the server to send back the session id not as a cookie, but
    * as json in the response.
    *
    * COULD RENAME: Add suffix: "...-In-Iframe" because that's where cookies can be
    * blocked / cause the browser to not show the iframe at all.
    */
  val AvoidCookiesHeaderName = "X-Ty-Avoid-Cookies"
  val Avoid = "Avoid"

  /** All browsers without cookie id, are rate limited together, for now.
    */
  val NoCookiesBrowserId = "NoCoBrId"

  /** If cannot use cookies.
    */
  val SessionIdHeaderName = "X-Ty-Sid"

  /**
    * A session id cookie is created on the first page view.
    * It is cleared on logout, and a new one generated on login.
    * Lift-Web's cookies and session state won't last across server
    * restarts and I want to be able to restart the app servers at
    * any time so I don't use Lift's stateful session stuff so very much.
    */
  val SessionIdCookieName = "dwCoSid"

  /** Don't rename. Is used by AngularJS: AngularJS copies the value of
    * this cookie to the HTTP header just above.
    * See: http://docs.angularjs.org/api/ng.$http, search for "XSRF-TOKEN".
    * CLEAN_UP do rename to tyCoXsrf, Angular is since long gone.
    */
  val XsrfCookieName = "XSRF-TOKEN"

  /**
    * A HTTP header in which AngularJS sends any xsrf token, when AngularJS
    * posts JSON. (So you cannot rename this header.)
    * CLEAN_UP rename to X-Ty-Xsrf, Angular is since long gone.
    */
  val XsrfTokenHeaderName = "X-XSRF-TOKEN"

  private val BrowserIdCookieName = "dwCoBrId"

  def tooLowEntropy(value: St): Bo = {
    SECURITY // make more fancy. For now, just this:
    value.length < 10
  }

}


sealed abstract class CorsInfo {
  def isCrossOrigin: Boolean = false
  def hasCorsCreds: Boolean = false
  def isPreFlight: Boolean = false
}

object CorsInfo {
  case object NotCorsNoOriginHeader extends CorsInfo
  case class SameOrigins(requestAndTargetOrigin: String) extends CorsInfo

  case class OkayCrossOrigin(
    requestOrigin: String,
    override val hasCorsCreds: Boolean,
    override val isPreFlight: Boolean,
  ) extends CorsInfo {
    override def isCrossOrigin: Boolean = true

    // Should return Forbidden before this, then.
    dieIf(hasCorsCreds && isPreFlight, "TyE6933KR445")
  }
}


class EdSecurity(globals: Globals) {

  import EdHttp._

  private val logger = TyLogger("TySecurity")

  private val XsrfTokenInputName = "dw-fi-xsrf"

  /** Let the xsrf token one gets when logging in, expire a bit after the session,
    * so there won't be any weird xsrf error, before one gets logged out
    * because the sid expired. Hmm?
    */
  private val XsrfAliveExtraSeconds = 3600

  // Is this an allowed (CORS) Cross-Origin-Resource-Sharing request?
  def checkIfCorsRequest(request: RequestHeader, siteSettings: EffectiveSettings): CorsInfo = {

    val isPreFlight = request.method == "OPTIONS"

    // *For now*, only handle CORS requests to /-/v0/... so won't
    // accidentally break other endpoints, now when trying out CORS.
    if (request.path.indexOf("/-/v0/") != 0) {
      throwForbiddenIf(isPreFlight, "TyCORSPATH", "CORS only allowed in /-/v0/") // [CORSPATH]
      // We'll check cookie and xsrf token, just like before CORS support got added.
      return CorsInfo.NotCorsNoOriginHeader // (690732856Y)
    }

    // If the Origin header is *absent*, this cannot be a CORS request, because:
    // ""The `Origin` header is a version of the `Referer` [sic] header that
    //   does not reveal a path. It is used for all HTTP fetches whose
    //   request’s response tainting is "cors", as well as those where
    //   request’s method is neither `GET` nor `HEAD`. Due to compatibility
    //   constraints it is not included in all fetches.""
    // https://fetch.spec.whatwg.org/#origin-header  2020-05
    //
    // (About the Origin header:
    // ""the Origin header field indicates the origin(s) that "caused"
    //   the user agent [browser] to issue the request [...]
    //   For example, consider [a browser] that executes scripts on behalf of
    //   origins.  If one of those scripts causes the [browser] to issue an
    //   HTTP request, [the browser] MAY use the Origin header field to
    //   [tell the server from where the request comes]""
    // https://tools.ietf.org/html/rfc6454#section-7.2  2020-05
    // All modern browsers do the above, incl IE11, https://caniuse.com/#feat=cors 2020-05  )
    //
    // (Theoretically, some GET requests without Origin can be from another server,
    // e.g. for loading an image or script tag — but any script sending such requests,
    // cannot see the response. Such requests aren't CORS requests. Although there's
    // a trick with scripts called JSONP — it's obsoleted by CORS.)
    //
    val requestOrigin: String = request.headers.get(p_HNs.ORIGIN) getOrElse {
      return CorsInfo.NotCorsNoOriginHeader
    }

    // Nginx sends the host in the Host header. [ngx_host_hdr]
    // For now: (this uses the Host header too — there's no host in the request line)
    val targetHost: String = request.host
    // Later:
    //val targetHost: String = request.headers.get(p_HNs.HOST) getOrElse {
    //  throwForbidden("TyE0HOSTHDR", "Host header missing")
    //}

    throwForbiddenIf(
          isPreFlight && request.headers.get(p_HNs.ACCESS_CONTROL_REQUEST_METHOD).isEmpty,
          "TyENOTPREFL01", o"""All OPTIONS requests to here must be CORS
              pre-flight requests — but this is no pre-flight request? It has
              no ${p_HNs.ACCESS_CONTROL_REQUEST_METHOD} header""")

    // Could convert hostname to lowercase — Play Framework does that, here:
    // filters-helpers_2.12-2.8.1-sources.jar!/play/filters/cors/AbstractCORSPolicy.scala
    // in isSameOrigin() — but feels unnecessary, maybe slightly risky?
    // (Play Fmw does this:
    //    val x = new URI((if (request.secure) "https://" else "http://") +
    //        request.host.toLowerCase(Locale.ENGLISH))
    //    ...  == (x.getScheme, x.getHost, x.getPort)  )
    //
    // Require exact match instead.
    //
    // ----- Port
    //
    // Don' append:  globals.colonPort  — the Host header should include the port
    // number already, if it's non-standard:
    // >  A "host" without any trailing port information implies the default
    // >  port for the service requested (e.g., "80" for an HTTP URL).
    // https://www.w3.org/Protocols/rfc2616/rfc2616-sec14.html#sec14.23
    //
    // The Origin header also includes the port if non-standard:
    // >  <port> Optional
    // >  TCP port number on which the server is listening. If no port is given,
    // >  the default port for the service requested (e.g., "80" for an HTTP URL)
    // >  is implied.
    // https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Origin
    //
    // (However, some programs include the port also if it's the standard one,
    // e.g. the Baidu Spider: https://stackoverflow.com/a/19169789/694469.
    // So, could:   if targetHost ends with ':80' or ':443'  also compare with
    // requestOrigin + standard port.)
    //
    val targetOrigin = globals.schemeColonSlashSlash + targetHost
    val isSameOrigin = targetOrigin == requestOrigin


    // This'd be weird?
    throwForbiddenIf(isPreFlight && isSameOrigin,
          "TyEPREFLSAMEORG", o"""I don't want pre-flight requests to the same
              origin: $targetOrigin  (and target host was: $targetHost,
              request origin: $requestOrigin)""")

    if (isSameOrigin)
      return CorsInfo.SameOrigins(requestAndTargetOrigin = targetOrigin)

    // Ok request method?
    throwForbiddenIf(!isPreFlight && request.method != "GET" && request.method != "POST",
          "TyECORSMTD", s"Forbidden CORS request method: ${request.method}")

    // Ok URL path?  (currently dead code (690732856Y)) [CORSPATH]
    throwForbiddenIf(request.path.indexOf("/-/v0/") != 0,
          "TyECORSPATH", o"""CORS requests only allowed to url path: ${request.path},
            but you requested: ${request.path}""")

    // From an allowed external website?
    val okOrigins: Seq[String] = siteSettings.allowCorsFromParsed

    // (If this is a pre-flight request and CORS not allowed, then could reply
    // with CORS info headers and status 204, but why? Replying Forbidden is simpler.)
    throwForbiddenIf(!okOrigins.contains(requestOrigin),
          "TyECORSORIG", o"""This looks like a CORS (Cross-Origin) request,
            but this site doesn't allow CORS requests from your origin. Your origin is:
            $requestOrigin.  This site: $targetOrigin  (and target host was: $targetHost)""")

    // Without cookies?
    // ""By default, in cross-site XMLHttpRequest or Fetch invocations,
    //   browsers will not send credentials. A specific flag has to be set [...]""
    // https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS#Requests_with_credentials
    //   2020-05
    val hasCreds = request.cookies.nonEmpty
    throwForbiddenIf(hasCreds && !siteSettings.allowCorsCreds,
          "TyECORSCOOKIES", o"""This looks like a CORS (Cross-Origin) request,
            but it includes credentials (cookies), which this site doesn't allow.""")

    throwForbiddenIf(hasCreds && isPreFlight,
          "TyEPREFLCREDS", "CORS pre-flight request *with cookies* — not allowed.")

    // This cross-origin request is okay.
    CorsInfo.OkayCrossOrigin(
          requestOrigin, hasCorsCreds = hasCreds, isPreFlight = isPreFlight)
  }


  /**
   * Finds the session id and any xsrf token in the specified request;
   * throws an error if this is not a GET request and the xsrf token is bad.
   * @return The current SID and xsrf token. Or new ones if needed (with no
   * no user, no display name), and a new SID and xsrf cookie.
   * @throws ResultException, for non-GET requests,
   * if the SID or the XSRF token is bad.
   *
   * However, for GET request where `maySetCookies` is false, and there
   * is no XSRF cookie, creates no new cookies, and returns XsrfOk("").
   * (No cookies should be set if the response might be cached by a proxy
   * server.)
   *
   * WebSocket: xsrf token checked in 1st message from the client instead [WSXSRF]
   * but not here (the WebSocket upgrade request has no body, no custom headers).
   */
  def checkSidAndXsrfToken[A](request: RequestHeader, anyRequestBody: Option[A],
        siteId: SiteId, expireIdleAfterMins: i64, maySetCookies: Bo, skipXsrfCheck: Bo)
        : (SidStatus, XsrfOk, List[Cookie]) = {

    val expireIdleAfterMillis: Long = expireIdleAfterMins * MillisPerMinute

    // If we cannot use cookies, then the sid is sent in a header. [NOCOOKIES]
    val anySessionIdCookieValue: Opt[St] = urlDecodeCookie(SessionIdCookieName, request)
    val anySessionId: Opt[St] =
          anySessionIdCookieValue orElse request.headers.get(SessionIdHeaderName)

    val now = globals.now()

    val sessionIdStatus: SidStatus =
          anySessionId.map(
            checkSessionId(siteId, _, now, expireIdleAfterMillis = expireIdleAfterMillis)
            ) getOrElse SidAbsent

    // On GET requests, simply accept the value of the xsrf cookie.
    // (On POST requests, however, we check the xsrf form input value)
    val anyXsrfCookieValue = urlDecodeCookie(XsrfCookieName, request)

    val sidXsrfNewCookies: (SidStatus, XsrfOk, List[Cookie]) =
      if (request.method == "GET" || skipXsrfCheck) {
        // Accept this request, and create new XSRF token if needed.
        // Don't throw anything (for now at least). [GETNOTHROW]

        if (!sessionIdStatus.canUse && !sessionIdStatus.isInstanceOf[SidExpired])
          logger.warn(s"Bad SID: $sessionIdStatus, from IP: ${realOrFakeIpOf(request)}")

        val (xsrfOk: XsrfOk, anyNewXsrfCookie: List[Cookie]) =
          if (anyXsrfCookieValue.isDefined) {
            (XsrfOk(anyXsrfCookieValue.get), Nil)
          }
          else if (!maySetCookies) {
            // No XSRF token available, and none needed, since this a GET request. [2WKA40]
            // (If is WebSocket, then, xsrf handled elsewhere: [WSXSRF].)
            // Also, this makes [privacy-badger] happy. [NOCOOKIES]
            // Could set the xsrf token to any xsrf header value? But then ought to check if
            // it's been properly crypto hash signed — would be better to avoid (don't want to
            // compute hashes if not needed anyway).
            (XsrfOk(""), Nil)
          }
          else {
            val newXsrfOk = createXsrfToken()
            val cookie = urlEncodeCookie(XsrfCookieName, newXsrfOk.value)
            (newXsrfOk, List(cookie))
          }

        (sessionIdStatus, xsrfOk, anyNewXsrfCookie)
      }
      else if (request.method != "POST") {
        // Sometimes people do `curl -I http://...` which sends a HEAD
        // request — but only GET and POST, sometimes OPTIONS,
        // are allowed.  It's nice, though, if in the X-Error-Code response
        // header there's an easy to read error code, so the cURL user
        // won't need to visit Ty's support forum and ask what's happening.
        // Hence the below unusually long "TyE_..." error codes with underscores:
        val details = s"Request method not allowed: ${request.method}"
        throwForbiddenIf(request.method == "HEAD",
              "TyE_REQUEST_METHOD__HEAD__NOT_ALLOWED", details)
        throwForbidden( "TyE_REQUEST_METHOD_NOT_ALLOWED", details)
      }
      else {
        // Reject this request if the XSRF token is invalid,
        // or if the SID is corrupt (but not if simply absent).

        // There must be an xsrf token in a certain header, or in a certain
        // input in any POST:ed form data. Check the header first, in case
        // this is a JSON request (then there is no form data).
        val xsrfToken = request.headers.get(XsrfTokenHeaderName) orElse {
          if (anyRequestBody.isEmpty) None else anyRequestBody.get match {
            case params: Map[String, Seq[String]] =>
              params.get(XsrfTokenInputName).map(_.head)
            case body: JsonOrFormDataBody =>
              body.getFirst(XsrfTokenInputName)
            case str: String =>
              val xsrfToken = str.takeWhile(_ != '\n') // [7GKW20TD]
              if (xsrfToken.nonEmpty) Some(xsrfToken)
              else None
            case _ =>
              None
          }
        } getOrElse
            throwForbidden("TyE0XSRFTKN", "No xsrf token")

        val xsrfOk = {
          val xsrfStatus =
            checkXsrfToken(
              xsrfToken, anyXsrfCookieValue,
              thereIsASidCookie = anySessionIdCookieValue.isDefined,
              now, expireIdleAfterMillis = expireIdleAfterMillis)

          def helpText(theProblem: String, nowHaveOrWillGet: String): String = i"""
            |Security issue: $theProblem. Please try again:
            |  - Click any button you just clicked, again.
            |  - Or reload the page.
            |  - Or return to the previous page and reload it.
            |
            |If you reload the page, copy-paste any unsaved text to a text editor,
            |or it'll be lost on reload.
            |
            |(You $nowHaveOrWillGet a new XSRF token.)
            """

          if (!xsrfStatus.isOk && !maySetCookies) {
            // This can happen if the same browser window is open so long, so that the
            // xsrfTokenIfNoCookies expires.
            val (theProblem, errorCode)  =
              if (xsrfStatus == XsrfExpired) ("xsrf token expired", "TyEXSRFEXP1")
              else if (xsrfStatus == XsrfBadEmpty) ("xsrf token empty", "TyEXSRFEMPTY1")
              else if (xsrfToken == "null") ("xsrf token is 'null'", "TyEXSRFNULL")
              else if (xsrfToken == "undefined") ("xsrf token is 'undefined'", "TyEXSRFUNDF")
              else ("bad xsrf token", "TyEXSRFBAD1")

            throwForbidden(
                errorCode, helpText(theProblem, "will get"))
          }
          else if (!xsrfStatus.isOk) {
            // Can happen for example if the xsrf token expires. Or if the server restarts,
            // with a new app secret.

            // Create a new XSRF cookie so whatever-the-user-attempted
            // will work, should s/he try again.
            // (If Javascript is enabled, debiki.js should detect logins
            // in other browser tabs, and then check the new SID cookie and
            // refresh XSRF tokens in any <form>s.)
            val newXsrfCookie =
              urlEncodeCookie(XsrfCookieName, createXsrfToken().value)

            // If this request is indeed part of one of Mallory's XSRF attacks,
            // the cookie still won't be sent to Mallory's web page, so creating
            // a new token should be safe. However, it makes it possible for
            // Mallory to conduct a DoS attack against [the user that makes
            // this request], if the user has Javascript disabled (since
            // Malory can change the user's XSRF token by attempting an XSRF
            // attack, but the web page cannot update the XSRF form <input>s
            // with the new value). This feels rather harmless though, and I
            // think it's more likely that I change the server side code in
            // some manner (e.g. I'm thinking about rejecting XSRF tokens that
            // are very old) and then it's a good thing that a new valid
            // token be created here. (?)

            val (theProblem, errorCode) =
              if (xsrfStatus == XsrfExpired) ("xsrf token expired", "TyEXSRFEXP_")
              else if (xsrfStatus == XsrfBadEmpty) ("xsrf token empty", "TyEXSRFEMPTY2")
              else if (anyXsrfCookieValue.isEmpty) ("no xsrf double submit cookie", "TyE0XSRFCO")
              else ("xsrf token doesn't match double submit cookie", "TyEXSRFCOMISM")

            throw ResultException(ForbiddenResult(
              errorCode, helpText(theProblem, "now have")).withCookies(newXsrfCookie))
          }

          xsrfStatus.asInstanceOf[XsrfOk]
        }

        CLEAN_UP // simplify this weird match-case!  & don't take & "return"
        // sessionIdStatus for no reason all the time.
        val r = sessionIdStatus match {
          case s: SidOk => (s, xsrfOk, Nil)
          case SidAbsent => (SidAbsent, xsrfOk, Nil)
          case s: SidExpired => (s, xsrfOk, Nil)
          case _ =>
            throw ResultException(
              ForbiddenResult("TyEBADSID", "Bad session ID",
                  "You can try again — I just deleted the bad session ID.")
                .discardingCookies(
                  DiscardingSessionCookie))
        }
        dieIf(isDevOrTest && r != (sessionIdStatus, xsrfOk, Nil), "TyE205RKPG36")
        r
      }

    sidXsrfNewCookies
  }


  private val MinOwnerPasswordLength = 10

  def throwErrorIfPasswordBad(
        password: String, username: String, fullName: Option[String], email: String,
        minPasswordLength: Int, isForOwner: Boolean): Unit = {

    // **The below checks aren't so important** — this is already done client side via zxcvbn.
    // Here, just quick double checks. (Only maybe reserved-words isn't totally done
    // by zxcvbn?)

    throwBadRequestIf(isForOwner && password.length < MinOwnerPasswordLength,
        "TyEADMPWMIN_", o"""Password too short, should be min $MinOwnerPasswordLength chars
        for you, because you're the community owner. (And at least $minPasswordLength for others.)""")

    throwBadRequestIf(password.length < minPasswordLength,
      "TyEPWMIN_", s"Password too short, should be $minPasswordLength chars")

    def fairlyMuchLongerThan(word: String) =
      (password.length - word.length) >= (if (isForOwner) 6 else 4)

    ReservedNames.includesReservedWord(password) foreach { theWord =>
      throwBadRequestIf(!fairlyMuchLongerThan(theWord),
          "TyE3WKB10", s"Password too simple, includes a reserved word: '$theWord' [TyEPWDSMPL]")
    }

    val lowercasePwd = password.toLowerCase

    if (lowercasePwd.indexOf(username.toLowerCase) >= 0 && !fairlyMuchLongerThan(username))
      throwBadReq("TyE3WKB10", s"The password includes your username: '$username' [TyEPWDUSN]")

    // Client side, zxcvbn does a better check.
    if (fullName.isDefined && lowercasePwd.indexOf(fullName.get.toLowerCase) >= 0
        && !fairlyMuchLongerThan(fullName.get))
      throwBadReq("TyE3WKB10", "The password includes your name [TyEPWDFLN]")

    if (lowercasePwd.indexOf(email.toLowerCase) >= 0 && !fairlyMuchLongerThan(email))
      throwBadReq("TyE3WKB10", "Password includes email [TyEPWDEML]")

    // If it's too long, then it's not a password? It's some other weird thing, perhaps bad?
    if (password.length > 80)
      throwBadReq("Password too long (80 chars max) [TyEPWDMAX]")

    /* Server side pwd check disabled  CLEAN_UP remove
    val passwordStrength = Nashorn.calcPasswordStrength(
      password = password, username = username, fullName = fullName, email = email)
    if (!passwordStrength.isStrongEnough)
      throwBadReq("DwE4KFEK8", o"""Password not strong enough. Please go back and try again.
          Estimated crack time: ${passwordStrength.crackTimeDisplay}, for someone with
          100 computers and access to the scrypt hash.""")
          */
  }


  /** Cleartext password allowed in tests only. Cleartext passwords must start with 'public'
    * so whenever one sees a cleartext password, one knows that it is
    * really intended to be public, for tests only (or, if not 'public...', it shouldn't be there).
    */
  def throwIfBadPassword(passwordHash: String, isTest: Boolean): Unit = {
    val array = passwordHash.split(':')
    if (array.length != 2)
      throwIllegalArgument("EsE2YPU5", "Bad password hash: no prefix")
    val prefix = array(0) + ":"
    val hash = array(1)

    if (prefix == DbDao.CleartextPrefix && !isTest && !hash.startsWith("public"))
      throwIllegalArgument("TyE502TKRD2",
        "Cleartext password does not start with 'public'")

    if (!isTest && prefix != DbDao.ScryptPrefix)
      throwIllegalArgument("EsE5YMP2", "Password type not allowed: " + prefix)
  }



  private def checkXsrfToken(xsrfToken: St, anyXsrfCookieValue: Opt[St],
        thereIsASidCookie: Bo, now: When, expireIdleAfterMillis: i64): XsrfStatus = {
    SECURITY; TESTS_MISSING // that tests if the wrong hashes are rejected

    // Check matches cookie, or that there's an ok crypto hash.
    val xsrfOk: XsrfOk = anyXsrfCookieValue match {
      case Some(xsrfCookieValue) =>
        // The Double Submit Cookie pattern [4AW2J7], usually also the Custom Request Header pattern, see:
        // https://www.owasp.org/index.php/Cross-Site_Request_Forgery_(CSRF)_Prevention_Cheat_Sheet
        if (xsrfCookieValue != xsrfToken) {
          return XsrfBad
        }
        if (xsrfToken.isEmpty) {
          return XsrfBadEmpty // probably cannot happen
        }
        XsrfOk(xsrfToken)
      case None =>
        // If the browser could send a session id cookie, it can also send a xsrf cookie?
        dieIf(Globals.isDevOrTest && thereIsASidCookie, "TyESID0XTKN",
            "Got a sid cookie but no xsrf cookie, weird")

        // The Encrypted Token Pattern, usually also the Custom Request Header pattern.
        //
        // This is actually not needed, if !thereIsASidCookie, because then xsrf
        // requests aren't possible (since no automatic credentials were included).
        // Unless using HTTP Basic Auth or Digest Auth but Ty doesn't — the browser
        // would include them automatically, just like cookies, right. But
        // the Ty browser app doesn't use Basic or Digest auth.
        // Do this check anyway, also if !thereIsASidCookie  (can be used for
        // rate limiting, if nothing else?).
        //
        val hashIndex: Int = xsrfToken.length - HashLength
        if (hashIndex < 1) {
          return XsrfBad
        }
        val value = xsrfToken.take(hashIndex - 1) // drops the dot between value and hash
        val actualHash = xsrfToken.drop(hashIndex)
        val correctHashFullLength = hashSha1Base64UrlSafe(value + secretSalt)
        val correctHash = correctHashFullLength take HashLength
        if (correctHash != actualHash) {
          return XsrfBad
        }
        XsrfOk(value)
    }

    // Check isn't too old.
    val unixSeconds: Long = xsrfOk.unixSeconds
    val millisAgo = now.millisSince(When.fromMillis(unixSeconds * MillisPerSecond))
    if (millisAgo > expireIdleAfterMillis + XsrfAliveExtraSeconds * MillisPerSecond)
      return XsrfExpired

    xsrfOk
  }


  /**
   * Generates a new XSRF token, based on the current date-time and a random number.
   *
   * If the hash is correct, and the date-time not too old, the token is okay.
   *
   * (The token is not based on the SID, because when a user loads his/her
   * very first page and logins for the first time, no SID is available.)
   */
  def createXsrfToken(): XsrfOk = {
    COULD_OPTIMIZE // skip the secure hash, when using the Double Submit Cookie pattern [4AW2J7].
    XsrfOk(timeDotRandomDotHash())  // [2AB85F2]
  }


  def createSessionIdAndXsrfToken(siteId: SiteId, userId: UserId): (SidOk, XsrfOk, List[Cookie]) = {
    COULD_OPTIMIZE // pass settings or a dao to here instead? so won't need to create this 2nd one.
                    // (the caller always already has one)
    val dao = globals.siteDao(siteId)

    val ppt = dao.getParticipant(userId)
    throwForbiddenIf(ppt.exists(_.isGroup), "TyELGIGRP", "Cannot login as a group")  // [imp-groups]

    val settings = dao.getWholeSiteSettings()
    val expireIdleAfterSecs = settings.expireIdleAfterMins * 60

    // Note that the xsrf token is created using the non-base64 encoded cookie value.
    val sidOk = createSessionId(siteId, userId)
    val xsrfOk = createXsrfToken()
    UX; SECURITY; SHOULD // use HttpOnly cookies — otherwise Safari will delete the cookie
    // after 7 days. See: https://webkit.org/blog/8613/intelligent-tracking-prevention-2-1/
    // the "Client-Side Cookies Capped to 7 Days of Storage", section, and sub section
    // "Will This Change Log Users Out?" — cookies that are Secure and HttpOnly aren't deleted.
    // This means the client can no longer look at the session cookie, to find out if one is
    // logged in? Could add JS variables instead.  [NOCOOKIES]
    val sidCookie = urlEncodeCookie(SessionIdCookieName, sidOk.value,
      maxAgeSecs = Some(expireIdleAfterSecs))
    val xsrfCookie = urlEncodeCookie(XsrfCookieName, xsrfOk.value,
      maxAgeSecs = Some(expireIdleAfterSecs + XsrfAliveExtraSeconds))
    (sidOk, xsrfOk, sidCookie::xsrfCookie::Nil)
  }


  private val HashLength: Int = 15
  private def secretSalt = globals.applicationSecret


  private def checkSessionId(siteId: SiteId, value: String, now: When, expireIdleAfterMillis: Long)
      : SidStatus = {
    // Example value: 88-F7sAzB0yaaX.1312629782081.1c3n0fgykm  - no, obsolete
    if (value.length <= HashLength) return SidBadFormat
    val (hash, dotUseridDateRandom) = value splitAt HashLength
    val realHash = hashSha1Base64UrlSafe(
      s"$secretSalt.$siteId$dotUseridDateRandom") take HashLength
    if (hash != realHash) return SidBadHash
    dotUseridDateRandom.drop(1).split('.') match {
      case Array(userIdString, dateStr, randVal) =>
        val userId: Option[UserId] =
          if (userIdString.isEmpty) None
          else Try(userIdString.toInt).toOption orElse {
            return SidBadFormat
          }
        val ageMillis = now.millis - dateStr.toLong
        UX; BUG; COULD; // [EXPIREIDLE] this also expires *active* sessions. Instead,
        // lookup the user, and consider only time elapsed, since hens last visit.
        // ... Need to have a SiteDao here then. And pass the Participant back to the
        // caller, so it won't have to look it up again.
        // Not urgent though — no one will notice: by default, one stays logged in 1 year [7AKR04].
        if (ageMillis > expireIdleAfterMillis)
          return SidExpired(
            minutesOld = ageMillis / MillisPerMinute,
            maxAgeMins = expireIdleAfterMillis / MillisPerMinute)
        SidOk(
          value = value,
          ageInMillis = ageMillis,
          userId = userId)
      case _ => SidBadFormat
    }
  }


  private def createSessionId(siteId: SiteId, userId: UserId): SidOk = {
    // For now, create a SID value and *parse* it to get a SidOk.
    // This is stupid and inefficient.
    val now = globals.now()
    val uid = "" // for now
    val useridDateRandom =
         userId +"."+
         now.millis +"."+
         (nextRandomString() take 10)
    // If the site id wasn't included in the hash, then an admin from site A could
    // login as admin at site B, if they have the same user id and username.
    val saltedHash = hashSha1Base64UrlSafe(
      s"$secretSalt.$siteId.$useridDateRandom") take HashLength
    val value = s"$saltedHash.$useridDateRandom"

    checkSessionId(siteId, value, now, expireIdleAfterMillis = Long.MaxValue).asInstanceOf[SidOk]
  }


  // ----- Secure cookies

  def SecureCookie(name: String, value: String, maxAgeSeconds: Option[Int] = None,
        httpOnly: Boolean = false) =
    Cookie(
      name,
      value,
      maxAge = maxAgeSeconds,
      secure = globals.secure,
      httpOnly = httpOnly,
      sameSite = anySameSiteCookieValue())

  /**
    * Later, could change to Lax or even Strict, for session id cookie,
    * and, when embedded, always send session id via header instead?
    * Or now directly? There are SameSite: None incompatible browsers:
    * https://www.chromium.org/updates/same-site/incompatible-clients
    *   ??? copy-paste that Apache 2 to here ???
    * Ok explanation of Strict, Lax and None:
    *   https://web.dev/samesite-cookies-explained/
    */
  private def anySameSiteCookieValue(): Option[Cookie.SameSite] = {  // [SAMESITE]
    // SameSite.None only works with https.
    if (globals.secure && globals.config.sameSiteNone) {
      Some(Cookie.SameSite.None)
    }
    else if (globals.config.sameSiteLax) {
      Some(Cookie.SameSite.Lax)
    }
    else {
      None
    }
  }


  def DiscardingSecureCookie(name: String) =
    DiscardingCookie(name, secure = globals.secure)

  def DiscardingSessionCookie: DiscardingCookie = DiscardingSecureCookie(SessionIdCookieName)
  // Maybe also always delete:  ImpersonationCookieName  ?
  // Well, things work fine anyway as of now (Mars 2020).

  // Two comments on the encoding of the cookie value:
  // 1. If the cookie contains various special characters
  // (whitespace, any of: "[]{]()=,"/\?@:;") it will be
  // sent as a Version 1 cookie (by javax.servlet.http.Cookie),
  // then it is surrounded with quotes.
  // the jQuery cookie plugin however expects an urlencoded value:
  // 2. urlEncode(value) results in these cookies being sent:
  //    Set-Cookie: dwCoUserEmail="kajmagnus79%40gmail.com";Path=/
  //    Set-Cookie: dwCoUserName="Kaj%20Magnus";Path=/
  // No encoding results in these cookies:
  //    Set-Cookie: dwCoUserEmail=kajmagnus79@gmail.com;Path=/
  //    Set-Cookie: dwCoUserName="Kaj Magnus";Path=/
  // So it seems a % encoded string is surrounded with double quotes, by
  // javax.servlet.http.Cookie? Why? Not needed!, '%' is safe.
  // So I've modified jquery-cookie.js to remove double quotes when
  // reading cookie values.
  private def urlEncodeCookie(name: String, value: String, maxAgeSecs: Option[Int] = None) =
    Cookie(
      name = name,
      value = urlEncode(convertEvil(value)),  // see comment above
      maxAge = maxAgeSecs,
      path = "/",
      domain = None,
      secure = globals.secure,
      sameSite = anySameSiteCookieValue(),
      httpOnly = false)


  /** Extracts any browser id cookie from the request, or creates it if absent
    * and is a POST request.
    */
  def getBrowserIdCreateCookieIfMissing(request: RequestHeader, isLogin: Boolean)
        : (Option[BrowserId], List[Cookie]) = {
    val anyBrowserId = getAnyBrowserId(request)
    if (anyBrowserId.isDefined) {
      return (Some(anyBrowserId.get), Nil)
    }

    // No id needed?
    val method = request.method
    if (method == "GET" || method == "OPTIONS" || method == "HEAD") {
      // Some one-time secret endpoints make things happen via GET requests
      // — then we want a cookie, although is GET, [GETLOGIN]
      // since the request makes thing happen in the server and database,
      // then, should remember the browser so simpler to detect abuse / attacks / etc.
      if (!isLogin) {
        // Probably harmless, don't need to remember the browser.
        return (None, Nil)
      }
    }

    // This request tries to do something (POST request, or GET login). Try to remember
    // the browser, so can maybe block or rate limit it, if needed. And maybe
    // detect astroturfing.
    createBrowserIdCookie()
  }

  def getAnyBrowserId(request: RequestHeader): Option[BrowserId] =
    request.cookies.get(BrowserIdCookieName) map { cookie =>
      BrowserId(cookie.value, isNew = false)
    }


  private def createBrowserIdCookie(): (Some[BrowserId], List[Cookie]) = {
    val cookieValue = timeDotRandomDotHash()  // [2AB85F2]
    val newCookie = SecureCookie(
      name = BrowserIdCookieName,
      value = cookieValue,
      maxAgeSeconds = Some(3600 * 24 * 365 * 5),
      httpOnly = true)
    (Some(BrowserId(cookieValue, isNew = true)), List(newCookie))
  }


  /** Returns something like:  12345.randomChars.123def — the first part, is the unix time,
    * in seconds. The second part is random chars. The last is a dot and
    * a crypto hash of the two first parts + the app secret.
    */
  private def timeDotRandomDotHash(): String = {
    val timeDotRandom = globals.now().seconds + "." + nextRandomString().take(12)
    val hash = hashSha1Base64UrlSafe(timeDotRandom + secretSalt).take(HashLength)
    s"$timeDotRandom.$hash"  // does *not* incl the secretSalt
  }

  // ----- Secure Not-fond and No-may-not

  /** Use this if page not found, or the page is private and we don't want strangers
    * to find out that it exists. [7C2KF24]
    */
  def throwIndistinguishableNotFound(devModeErrCode: String = ""): Nothing = {
    val suffix =
      if (!globals.isProd && devModeErrCode.nonEmpty) s"-$devModeErrCode"
      else ""
    throwNotFound("TyE404_" + suffix, "Page not found")
  }

  def throwNoUnless(mayMaybe: MayMaybe, errorCode: String): Unit = {
    import MayMaybe._
    mayMaybe match {
      case Yes => // fine
      case NoNotFound(debugCode) => throwIndistinguishableNotFound(debugCode)
      case NoMayNot(code2, reason) => throwForbidden(s"$errorCode-$code2", reason)
    }
  }


  // ----- Magic passwords


  /** The real ip address of the client, unless a fakeIp url param or dwCoFakeIp cookie specified
    * In prod mode, an e2e test password cookie is required.
    *
    * (If 'fakeIp' is specified, actions.SafeActions.scala copies the value to
    * the dwCoFakeIp cookie.)
    */
  def realOrFakeIpOf(request: RequestHeader): String = {
    val fakeIpQueryParam = request.queryString.get("fakeIp").flatMap(_.headOption)
    val fakeIp = fakeIpQueryParam.orElse(
      request.cookies.get("dwCoFakeIp").map(_.value))  getOrElse {
      return request.headers.get("X-Real-IP") getOrElse request.remoteAddress
    }

    if (globals.isProd) {
      def where = fakeIpQueryParam.isDefined ? "in query param" | "in cookie"
      val password = getE2eTestPassword(request) getOrElse {
        throwForbidden(
          "DwE6KJf2", s"Fake ip specified $where, but no e2e test password — required in prod mode")
      }
      val correctPassword = globals.e2eTestPassword getOrElse {
        throwForbidden(
          "DwE7KUF2", "Fake ips not allowed, because no e2e test password has been configured")
      }
      if (password != correctPassword) {
        throwForbidden(
          "DwE2YUF2", "Fake ip forbidden: Wrong e2e test password")
      }
    }

    // Dev or test mode, or correct password, so:
    fakeIp
  }


  def getE2eTestPassword(request: RequestHeader): Option[String] =
    request.queryString.get("e2eTestPassword").flatMap(_.headOption).orElse(
      request.cookies.get("dwCoE2eTestPassword").map(_.value)).orElse( // dwXxx obsolete. esXxx now
      request.cookies.get("esCoE2eTestPassword").map(_.value))


  def hasOkE2eTestPassword(request: RequestHeader): Boolean = {
    getE2eTestPassword(request) match {
      case None => false
      case Some(password) =>
        val correctPassword = globals.e2eTestPassword getOrElse throwForbidden(
          "EsE5GUM2", "There's an e2e test password in the request, but not in any config file")
        if (password != correctPassword) {
          throwForbidden("EsE2FWK4", "The e2e test password in the request is wrong")
        }
        true
    }
  }


  def getForbiddenPassword(request: RequestHeader): Option[String] =
    request.queryString.get("forbiddenPassword").flatMap(_.headOption).orElse(
      request.cookies.get("esCoForbiddenPassword").map(_.value))


  def hasOkForbiddenPassword(request: DebikiRequest[_]): Boolean =
    hasOkForbiddenPassword(request.underlying)


  def hasOkForbiddenPassword(request: RequestHeader): Boolean = {
    getForbiddenPassword(request) match {
      case None => false
      case Some(password) =>
        val correctPassword = globals.forbiddenPassword getOrElse throwForbidden(
          "EsE48YC2", "There's a forbidden-password in the request, but not in any config file")
        if (password != correctPassword) {
          throwForbidden("EsE7UKF2", "The forbidden-password in the request is wrong")
        }
        true
    }
  }
}

