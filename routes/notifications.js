const express = require('express');
const {
  listNotificationsForUser,
  markAllNotificationsRead,
  markNotificationRead,
  unreadNotificationCount
} = require('../lib/notifications');
const { requireFreshPin } = require('../middleware/auth');

const router = express.Router();
router.use(requireFreshPin);

router.get('/', (req, res) => {
  res.json({
    items: listNotificationsForUser(req.user.userId),
    unread_count: unreadNotificationCount(req.user.userId)
  });
});

router.post('/:id/read', (req, res) => {
  markNotificationRead(req.user.userId, req.params.id);
  res.json({ ok: true, unread_count: unreadNotificationCount(req.user.userId) });
});

router.post('/read-all', (req, res) => {
  markAllNotificationsRead(req.user.userId);
  res.json({ ok: true, unread_count: 0 });
});

module.exports = router;
