"use strict"

Object.defineProperty(exports, "__esModule", { value: true })

const Types_1 = require("../Types")
const Utils_1 = require("../Utils")
const WABinary_1 = require("../WABinary")
const groups_1 = require("./groups")
const mex_1 = require("./mex")

const parseNewsletterMetadata = (metadata) => {
    if (metadata?.result && typeof metadata.result === 'object') {
        metadata = metadata.result
    }
    if (!metadata || typeof metadata.id !== 'string') {
        throw new Error('newsletter: MEX response does not contain newsletter metadata')
    }

    const thread = metadata.thread_metadata || {}
    const viewer = metadata.viewer_metadata || {}
    const timestamp = (value) => Number.parseInt(value ?? '0', 10)

    return {
        id: metadata.id,
        state: metadata.state?.type || metadata.state,
        creation_time: timestamp(thread.creation_time),
        name: thread.name?.text || thread.name || '',
        nameTime: timestamp(thread.name?.update_time),
        description: thread.description?.text || thread.description || '',
        descriptionTime: timestamp(thread.description?.update_time),
        invite: thread.invite || '',
        handle: thread.handle || null,
        picture: Utils_1.getUrlFromDirectPath(thread.picture?.direct_path || ''),
        preview: Utils_1.getUrlFromDirectPath(thread.preview?.direct_path || ''),
        reaction_codes: thread.settings?.reaction_codes?.value,
        subscribers: timestamp(thread.subscribers_count),
        verification: thread.verification,
        viewer_metadata: {
            mute: viewer.mute || 'UNDEFINED',
            view_role: viewer.view_role || viewer.role || 'GUEST'
        }
    }
}

const makeNewsletterSocket = (config) => {
    const sock = groups_1.makeGroupsSocket(config)
    const { query, generateMessageTag } = sock
    const executeWMexQuery = (variables, queryId, dataPath) =>
        mex_1.executeWMexQuery(variables, queryId, dataPath, query, generateMessageTag)

    const newsletterQuery = (jid, type, content) => query({
        tag: 'iq',
        attrs: {
            id: generateMessageTag(),
            type,
            xmlns: 'newsletter',
            to: jid
        },
        content
    })

    const newsletterWMexQuery = (jid, queryId, content = {}) => query({
        tag: 'iq',
        attrs: {
            id: generateMessageTag(),
            type: 'get',
            xmlns: 'w:mex',
            to: WABinary_1.S_WHATSAPP_NET
        },
        content: [{
            tag: 'query',
            attrs: { query_id: queryId },
            content: Buffer.from(JSON.stringify({
                variables: { newsletter_id: jid, ...content }
            }), 'utf-8')
        }]
    })

    const newsletterUpdate = (jid, updates) =>
        executeWMexQuery(
            { newsletter_id: jid, updates: { ...updates, settings: updates.settings ?? null } },
            Types_1.QueryIds.UPDATE_METADATA,
            'xwa2_newsletter_update'
        )

    const newsletterMetadata = async (type, key, role) => {
        const metadata = await executeWMexQuery({
            fetch_creation_time: true,
            fetch_full_image: true,
            fetch_viewer_metadata: true,
            input: {
                key,
                type: type.toUpperCase(),
                view_role: role || 'GUEST'
            }
        }, Types_1.QueryIds.METADATA, Types_1.XWAPaths.xwa2_newsletter_metadata)
        return parseNewsletterMetadata(metadata)
    }

    const parseFetchedUpdates = async (node, type) => {
        const parent = type === 'messages'
            ? node
            : WABinary_1.getBinaryNodeChild(node, 'message_updates')
        const messages = WABinary_1.getBinaryNodeChild(parent, 'messages')
        const messageNodes = WABinary_1.getAllBinaryNodeChildren(messages)

        return Promise.all(messageNodes.map(async (messageNode) => {
            messageNode.attrs.from = messages?.attrs?.jid
            const views = Number.parseInt(
                WABinary_1.getBinaryNodeChild(messageNode, 'views_count')?.attrs?.count || '0',
                10
            )
            const reactionNode = WABinary_1.getBinaryNodeChild(messageNode, 'reactions')
            const reactions = WABinary_1.getBinaryNodeChildren(reactionNode, 'reaction')
                .map(({ attrs }) => ({ count: Number(attrs.count), code: attrs.code }))
            const update = { server_id: messageNode.attrs.server_id, views, reactions }

            if (type === 'messages') {
                const { fullMessage, decrypt } = await Utils_1.decryptMessageNode(
                    messageNode,
                    sock.authState.creds.me.id,
                    sock.authState.creds.me.lid || '',
                    sock.signalRepository,
                    config.logger
                )
                await decrypt()
                update.message = fullMessage
            }

            return update
        }))
    }

    return {
        ...sock,
        newsletterQuery,
        newsletterWMexQuery,
        newsletterCreate: async (name, description, picture) => {
            await query({
                tag: 'iq',
                attrs: {
                    to: WABinary_1.S_WHATSAPP_NET,
                    xmlns: 'tos',
                    id: generateMessageTag(),
                    type: 'set'
                },
                content: [{
                    tag: 'notice',
                    attrs: { id: '20601218', stage: '5' },
                    content: []
                }]
            })

            const metadata = await executeWMexQuery({
                input: {
                    name,
                    description: description ?? null,
                    picture: picture
                        ? (await Utils_1.generateProfilePicture(picture)).img.toString('base64')
                        : null,
                    settings: { reaction_codes: { value: 'ALL' } }
                }
            }, Types_1.QueryIds.CREATE, Types_1.XWAPaths.xwa2_newsletter_create)
            return parseNewsletterMetadata(metadata)
        },
        newsletterUpdate,
        newsletterSubscribers: async (jid) => {
            const result = await newsletterWMexQuery(undefined, Types_1.QueryIds.SUBSCRIBERS, {
                newsletter_id: jid
            })
            const child = WABinary_1.getBinaryNodeChild(result, 'result')
            if (!child?.content) {
                throw new Error('newsletter subscribers: response has no result payload')
            }

            const payload = JSON.parse(child.content.toString())
            if (Array.isArray(payload.errors) && payload.errors.length) {
                throw new Error(payload.errors.map(error => error.message || 'Unknown error').join(', '))
            }

            const data = payload.data
            const expected = data?.[Types_1.XWAPaths.xwa2_newsletter_subscribers]
            const countOf = (value, traverseAll = false) => {
                if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
                if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
                if (!value || typeof value !== 'object') return undefined

                for (const [key, count] of Object.entries(value)) {
                    if (![
                        'subscribers', 'subscribers_count', 'subscriberscount',
                        'subscriber_count', 'subscribercount', 'count',
                        'total', 'total_count', 'totalcount', 'count_value', 'countvalue'
                    ].includes(key.toLowerCase().replace(/[-\s]/g, '_').replace(/_/g, ''))) continue
                    if (typeof count === 'number' && Number.isFinite(count)) return count
                    if (typeof count === 'string' && /^\d+$/.test(count)) return Number(count)
                }

                for (const [key, nested] of Object.entries(value)) {
                    if (nested && typeof nested === 'object' &&
                        (traverseAll || /subscriber|newsletter|result|data/i.test(key))) {
                        const count = countOf(nested, traverseAll)
                        if (count !== undefined) return count
                    }
                }
                return undefined
            }
            const subscribers = countOf(expected) ?? countOf(data)
            if (subscribers === undefined) {
                try {
                    const metadata = await newsletterMetadata('jid', jid, 'OWNER')
                    if (Number.isFinite(metadata.subscribers) && metadata.subscribers >= 0) {
                        return { subscribers: metadata.subscribers }
                    }
                } catch (error) {
                    throw new Error(
                        `newsletter subscribers: response does not contain a subscriber count; metadata fallback failed: ${error.message}`,
                        { cause: error }
                    )
                }
                throw new Error('newsletter subscribers: response does not contain a subscriber count')
            }
            return { subscribers }
        },
        newsletterMetadata,
        newsletterFollow: (jid) =>
            executeWMexQuery(
                { newsletter_id: jid },
                Types_1.QueryIds.FOLLOW,
                Types_1.XWAPaths.xwa2_newsletter_join_v2
            ),
        newsletterUnfollow: (jid) =>
            executeWMexQuery(
                { newsletter_id: jid },
                Types_1.QueryIds.UNFOLLOW,
                Types_1.XWAPaths.xwa2_newsletter_leave_v2
            ),
        newsletterMute: (jid) =>
            executeWMexQuery(
                { newsletter_id: jid },
                Types_1.QueryIds.MUTE,
                Types_1.XWAPaths.xwa2_newsletter_mute_v2
            ),
        newsletterUnmute: (jid) =>
            executeWMexQuery(
                { newsletter_id: jid },
                Types_1.QueryIds.UNMUTE,
                Types_1.XWAPaths.xwa2_newsletter_unmute_v2
            ),
        newsletterReactionMode: (jid, mode) =>
            newsletterUpdate(jid, { settings: { reaction_codes: { value: mode } } }),
        newsletterUpdateName: (jid, name) => newsletterUpdate(jid, { name }),
        newsletterUpdateDescription: (jid, description) =>
            newsletterUpdate(jid, { description: description || '' }),
        newsletterUpdatePicture: async (jid, content) => {
            const { img } = await Utils_1.generateProfilePicture(content)
            await newsletterUpdate(jid, { picture: img.toString('base64') })
            return newsletterMetadata('jid', jid, 'OWNER')
        },
        newsletterRemovePicture: (jid) => newsletterUpdate(jid, { picture: '' }),
        newsletterAction: async (jid, action) => {
            const queryId = Types_1.QueryIds[action.toUpperCase()]
            if (!queryId) throw new Error(`newsletter: unsupported action '${action}'`)
            return executeWMexQuery({ newsletter_id: jid }, queryId)
        },
        newsletterFetchAllParticipating: async () => {
            const newsletters = await executeWMexQuery(
                {},
                Types_1.QueryIds.SUBSCRIBED,
                Types_1.XWAPaths.SUBSCRIBED
            )
            if (!Array.isArray(newsletters)) {
                throw new Error('newsletter: subscribed MEX response does not contain a newsletter list')
            }

            const participating = {}
            for (const { id } of newsletters) {
                if (!WABinary_1.isJidNewsletter(id)) continue
                const metadata = await newsletterMetadata('jid', id)
                participating[metadata.id] = metadata
            }
            return participating
        },
        newsletterAdminCount: async (jid) => {
            const response = await executeWMexQuery(
                { newsletter_id: jid },
                Types_1.QueryIds.ADMIN_COUNT,
                Types_1.XWAPaths.xwa2_newsletter_admin_count
            )
            return response.admin_count
        },
        newsletterChangeOwner: async (jid, newOwnerJid) => {
            await executeWMexQuery(
                { newsletter_id: jid, user_id: newOwnerJid },
                Types_1.QueryIds.CHANGE_OWNER,
                Types_1.XWAPaths.xwa2_newsletter_change_owner
            )
        },
        newsletterDemote: async (jid, userJid) => {
            await executeWMexQuery(
                { newsletter_id: jid, user_id: userJid },
                Types_1.QueryIds.DEMOTE,
                Types_1.XWAPaths.xwa2_newsletter_demote
            )
        },
        newsletterDelete: async (jid) => {
            await executeWMexQuery(
                { newsletter_id: jid },
                Types_1.QueryIds.DELETE,
                Types_1.XWAPaths.xwa2_newsletter_delete_v2
            )
        },
        newsletterReactMessage: async (jid, serverId, reaction) => {
            await query({
                tag: 'message',
                attrs: {
                    to: jid,
                    ...(reaction ? {} : { edit: '7' }),
                    type: 'reaction',
                    server_id: serverId,
                    id: generateMessageTag()
                },
                content: [{ tag: 'reaction', attrs: reaction ? { code: reaction } : {} }]
            })
        },
        newsletterFetchMessages: async (type, key, count, after) => {
            const result = await newsletterQuery(WABinary_1.S_WHATSAPP_NET, 'get', [{
                tag: 'messages',
                attrs: {
                    type,
                    ...(type === 'invite' ? { key } : { jid: key }),
                    count: count.toString(),
                    after: after?.toString() || '100'
                }
            }])
            return parseFetchedUpdates(result, 'messages')
        },
        newsletterFetchUpdates: async (jid, count, after, since) => {
            const result = await newsletterQuery(jid, 'get', [{
                tag: 'message_updates',
                attrs: {
                    count: count.toString(),
                    after: after?.toString() || '100',
                    since: since?.toString() || '0'
                }
            }])
            return parseFetchedUpdates(result, 'updates')
        },
        subscribeNewsletterUpdates: async (jid) => {
            const result = await newsletterQuery(jid, 'set', [{
                tag: 'live_updates',
                attrs: {},
                content: []
            }])
            const attrs = WABinary_1.getBinaryNodeChild(result, 'live_updates')?.attrs
            return attrs?.duration ? { duration: attrs.duration } : null
        }
    }
}

module.exports = { makeNewsletterSocket }
