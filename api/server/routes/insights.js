const express = require('express');
const {
  createInsightsAccessHandler,
  createInsightsHandler,
  createInsightsConversationMessagesHandler,
  isEnabled,
} = require('@librechat/api');
const { SystemCapabilities } = require('@librechat/data-schemas');
const { requireJwtAuth, checkAdmin } = require('~/server/middleware');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const db = require('~/models');

const router = express.Router();
const requireAdminAccess = requireCapability(SystemCapabilities.ACCESS_ADMIN);
const requireInsightsAccess = requireCapability(SystemCapabilities.READ_INSIGHTS);
const isInsightsEnabled = () => isEnabled(process.env.ENABLE_INSIGHTS);

router.use(requireJwtAuth, checkAdmin, requireAdminAccess, requireInsightsAccess);
router.get('/access', createInsightsAccessHandler({ isInsightsEnabled }));
router.get('/', createInsightsHandler({ isInsightsEnabled, getInsights: db.getInsights }));
router.get(
  '/conversations/:conversationId/messages',
  createInsightsConversationMessagesHandler({
    isInsightsEnabled,
    getMessages: db.getMessages,
  }),
);

module.exports = router;
