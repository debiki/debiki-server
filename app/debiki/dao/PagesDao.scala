/**
 * Copyright (C) 2014 Kaj Magnus Lindberg (born 1979)
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

package debiki.dao

import com.debiki.core._
import com.debiki.core.Prelude._
import com.debiki.core.PageParts.MaxTitleLength
import com.debiki.core.User.SystemUserId
import debiki._
import debiki.DebikiHttp._
import java.{util => ju}


/** Loads and saves pages and page parts (e.g. posts and patches).
  *
  * (There's also a class PageDao (with no 's' in the name) that focuses on
  * one specific single page.)
  */
trait PagesDao {
  self: SiteDao =>


  def createPage(pageRole: PageRole, pageStatus: PageStatus, anyCategoryId: Option[CategoryId],
        anyFolder: Option[String], anySlug: Option[String], titleSource: String, bodySource: String,
        showId: Boolean, authorId: UserId, browserIdData: BrowserIdData)
        : PagePath = {

    val bodyHtmlSanitized = siteDbDao.commonMarkRenderer.renderAndSanitizeCommonMark(bodySource,
      allowClassIdDataAttrs = true, followLinks = !pageRole.isWidelyEditable)
    if (bodyHtmlSanitized.trim.isEmpty)
      throwForbidden("DwE3KFE29", "Page body should not be empty")

    if (titleSource.length > MaxTitleLength)
      throwBadReq("DwE4HEFW8", s"Title too long, max length is $MaxTitleLength")

    val titleHtmlSanitized = siteDbDao.commonMarkRenderer.sanitizeHtml(titleSource)
    if (titleHtmlSanitized.trim.isEmpty)
      throwForbidden("DwE5KPEF21", "Page title should not be empty")

    readWriteTransaction { transaction =>
      val (pagePath, bodyPost) = createPageImpl(pageRole, pageStatus, anyCategoryId,
        anyFolder = anyFolder, anySlug = anySlug,
        titleSource = titleSource, titleHtmlSanitized = titleHtmlSanitized,
        bodySource = bodySource, bodyHtmlSanitized = bodyHtmlSanitized,
        showId = showId, authorId = authorId, browserIdData,
        transaction)

      val notifications = NotificationGenerator(transaction)
        .generateForNewPost(PageDao(pagePath.pageId getOrDie "DwE5KWI2", transaction), bodyPost)
      transaction.saveDeleteNotifications(notifications)
      pagePath
    }
  }


  def createPageImpl(pageRole: PageRole, pageStatus: PageStatus, anyCategoryId: Option[CategoryId],
        anyFolder: Option[String], anySlug: Option[String],
        titleSource: String, titleHtmlSanitized: String,
        bodySource: String, bodyHtmlSanitized: String,
        showId: Boolean, authorId: UserId, browserIdData: BrowserIdData,
        transaction: SiteTransaction): (PagePath, Post) = {

      val pageId = transaction.nextPageId()

      // Authorize and determine approver user id. For now:
      val author = transaction.loadUser(authorId) getOrElse throwForbidden("DwE9GK32", "User gone")

      val pageSlug = anySlug match {
        case Some(slug) =>
          if (!author.isStaff)
            throwForbidden("DwE4KFW87", "Only staff may specify page slug")
          slug
        case None =>
          siteDbDao.commonMarkRenderer.slugifyTitle(titleSource)
      }

      val approvedById =
        if (author.isStaff) {
          author.id
        }
        else {
          if (pageRole != PageRole.Discussion && pageRole != PageRole.Question &&
              pageRole != PageRole.Problem && pageRole != PageRole.Idea &&
              pageRole != PageRole.MindMap)
            throwForbidden("DwE5KEPY2", s"Bad forum topic page type: $pageRole")

          anyCategoryId match {
            case None =>
              throwForbidden("DwE8GKE4", "No category specified")
            case Some(parentId) =>
              die("63047490", "categories") /*
              val parentMeta = loadPageMeta(parentId) getOrElse throwNotFound(
                "DwE78BI21", s"Parent forum or category does not exist, id: '$parentId'")

              if (parentMeta.pageRole != PageRole.Category &&
                  parentMeta.pageRole != PageRole.Forum)
                throwForbidden("DwE830BIR5", "Parent page is not a forum or a forum category")

              // The System user currently approves all new forum topics.
              // SECURITY COULD analyze the author's trust level and past actions, and
              // based on that, approve, reject or review later.
              SystemUserId
              */
          }
        }

      val folder = anyFolder getOrElse "/"

      val pagePath = PagePath(siteId, folder = folder, pageId = Some(pageId),
        showId = showId, pageSlug = pageSlug)

      val titleUniqueId = transaction.nextPostId()
      val bodyUniqueId = titleUniqueId + 1

      val titlePost = Post.createTitle(
        siteId = siteId,
        uniqueId = titleUniqueId,
        pageId = pageId,
        createdAt = transaction.currentTime,
        createdById = authorId,
        source = titleSource,
        htmlSanitized = titleHtmlSanitized,
        approvedById = Some(approvedById))

      val bodyPost = Post.createBody(
        siteId = siteId,
        uniqueId = bodyUniqueId,
        pageId = pageId,
        createdAt = transaction.currentTime,
        createdById = authorId,
        source = bodySource,
        htmlSanitized = bodyHtmlSanitized,
        approvedById = Some(approvedById))

      val (pinOrder, pinWhere) =
        if (pageRole == PageRole.AboutCategory) (Some(3), Some(PinPageWhere.InCategory))
        else (None, None)
      val pageMeta = PageMeta.forNewPage(pageId, pageRole, authorId, transaction.currentTime,
        pinOrder = pinOrder, pinWhere = pinWhere,
        categoryId = anyCategoryId, url = None, publishDirectly = true)

      val auditLogEntry = AuditLogEntry(
        siteId = siteId,
        id = AuditLogEntry.UnassignedId,
        didWhat = AuditLogEntryType.NewPage,
        doerId = authorId,
        doneAt = transaction.currentTime,
        browserIdData = browserIdData,
        pageId = Some(pageId),
        pageRole = Some(pageRole))

      transaction.insertPageMeta(pageMeta)
      transaction.insertPagePath(pagePath)
      transaction.insertPost(titlePost)
      transaction.insertPost(bodyPost)
      insertAuditLogEntry(auditLogEntry, transaction)

      (pagePath, bodyPost)
  }


  def unpinPage(pageId: PageId) {
    readWriteTransaction { transaction =>
      val oldMeta = transaction.loadThePageMeta(pageId)
      val newMeta = oldMeta.copy(pinWhere = None, pinOrder = None)
      transaction.updatePageMeta(newMeta, oldMeta = oldMeta)
      // (COULD update audit log)
    }
    refreshPageInAnyCache(pageId)
  }


  def pinPage(pageId: PageId, pinWhere: PinPageWhere, pinOrder: Int) {
    readWriteTransaction { transaction =>
      val oldMeta = transaction.loadThePageMeta(pageId)
      val newMeta = oldMeta.copy(pinWhere = Some(pinWhere), pinOrder = Some(pinOrder))
      transaction.updatePageMeta(newMeta, oldMeta = oldMeta)
      // (COULD update audit log)
    }
    refreshPageInAnyCache(pageId)
  }


  def ifAuthAcceptAnswer(pageId: PageId, postUniqueId: PostId, userId: UserId,
        browserIdData: BrowserIdData): Option[ju.Date] = {
    val answeredAt = readWriteTransaction { transaction =>
      val user = transaction.loadTheUser(userId)
      val oldMeta = transaction.loadThePageMeta(pageId)
      if (oldMeta.pageRole != PageRole.Question)
        throwBadReq("DwE4KGP2", "This page is not a question so no answer can be selected")

      if (!user.isStaff && user.id != oldMeta.authorId)
        throwForbidden("DwE8JGY3", "Only staff and the topic author can accept an answer")

      val post = transaction.loadThePost(postUniqueId)
      if (post.pageId != pageId)
        throwBadReq("DwE5G2Y2", "That post is placed on another page, page id: " + post.pageId)

      // Pages are probably closed for good reasons, e.g. off-topic, and then it gives
      // the wrong impression if the author can still select an answer. It would seem as
      // if that kind of questions were allowed / on-topic.
      if (oldMeta.closedAt.isDefined)
        throwBadReq("DwE0PG26", "This question is closed, therefore no answer can be accepted")

      val answeredAt = Some(transaction.currentTime)
      val newMeta = oldMeta.copy(
        answeredAt = answeredAt,
        answerPostUniqueId = Some(postUniqueId),
        closedAt = answeredAt)
      transaction.updatePageMeta(newMeta, oldMeta = oldMeta)
      // (COULD update audit log)
      // (COULD wait 5 minutes (in case the answer gets un-accepted) then send email
      // to the author of the answer)
      answeredAt
    }
    refreshPageInAnyCache(pageId)
    answeredAt
  }


  def ifAuthUnacceptAnswer(pageId: PageId, userId: UserId, browserIdData: BrowserIdData) {
    readWriteTransaction { transaction =>
      val user = transaction.loadTheUser(userId)
      val oldMeta = transaction.loadThePageMeta(pageId)
      if (!user.isStaff && user.id != oldMeta.authorId)
        throwForbidden("DwE2GKU4", "Only staff and the topic author can unaccept the answer")

      val newMeta = oldMeta.copy(answeredAt = None, answerPostUniqueId = None, closedAt = None)
      transaction.updatePageMeta(newMeta, oldMeta = oldMeta)
      // (COULD update audit log)
    }
    refreshPageInAnyCache(pageId)
  }


  /** Changes status from New to Planned to Done, and back to New again.
    */
  def cyclePageDone(pageId: PageId, userId: UserId, browserIdData: BrowserIdData): PageMeta = {
    val newMeta = readWriteTransaction { transaction =>
      val oldMeta = transaction.loadThePageMeta(pageId)
      val pageRole = oldMeta.pageRole
      if (pageRole != PageRole.Problem && pageRole != PageRole.Idea && pageRole != PageRole.ToDo)
        throwBadReq("DwE6KEW2", "This page cannot be marked as planned or done")

      var newPlannedAt: Option[ju.Date] = None
      var newDoneAt: Option[ju.Date] = None
      var newClosedAt: Option[ju.Date] = None

      if (oldMeta.doneAt.isDefined) {
        // Keep all None, except for todos because they cannot be not-planned.
        if (pageRole == PageRole.ToDo) {
          newPlannedAt = oldMeta.plannedAt
        }
      }
      else if (oldMeta.plannedAt.isDefined) {
        newPlannedAt = oldMeta.plannedAt
        newDoneAt = Some(transaction.currentTime)
        newClosedAt = Some(transaction.currentTime)
      }
      else {
        newPlannedAt = Some(transaction.currentTime)
      }

      val newMeta = oldMeta.copy(
        plannedAt = newPlannedAt,
        doneAt = newDoneAt,
        closedAt = newClosedAt)
      transaction.updatePageMeta(newMeta, oldMeta = oldMeta)
      // (COULD update audit log)
      newMeta
    }
    refreshPageInAnyCache(pageId)
    newMeta
  }


  def ifAuthTogglePageClosed(pageId: PageId, userId: UserId, browserIdData: BrowserIdData)
        : Option[ju.Date] = {
    val newClosedAt = readWriteTransaction { transaction =>
      val user = transaction.loadTheUser(userId)
      val oldMeta = transaction.loadThePageMeta(pageId)
      if (!user.isStaff && user.id != oldMeta.authorId)
        throwForbidden("DwE5JPK7", "Only staff and the topic author can toggle it closed")

      val newClosedAt = oldMeta.closedAt match {
        case None => Some(transaction.currentTime)
        case Some(_) => None
      }
      val newMeta = oldMeta.copy(closedAt = newClosedAt)
      transaction.updatePageMeta(newMeta, oldMeta = oldMeta)
      // (COULD update audit log)
      newClosedAt
    }
    refreshPageInAnyCache(pageId)
    newClosedAt
  }
}



trait CachingPagesDao extends PagesDao {
  self: CachingSiteDao =>


  override def createPage(pageRole: PageRole, pageStatus: PageStatus,
        anyCategoryId: Option[CategoryId], anyFolder: Option[String], anySlug: Option[String],
        titleSource: String, bodySource: String,
        showId: Boolean, authorId: UserId, browserIdData: BrowserIdData)
        : PagePath = {
    val pagePath = super.createPage(pageRole, pageStatus, anyCategoryId,
      anyFolder, anySlug, titleSource, bodySource, showId, authorId, browserIdData)
    firePageCreated(pagePath)
    pagePath
  }

}

