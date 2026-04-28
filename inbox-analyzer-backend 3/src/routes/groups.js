const router = require('express').Router();
const auth = require('../middleware/auth');
const c = require('../controllers/groupsController');

router.get('/', auth, c.list);
router.post('/', auth, c.create);
router.get('/:id', auth, c.detail);
router.put('/:id', auth, c.update);
router.delete('/:id', auth, c.remove);

router.post('/:id/emails', auth, c.addEmails);
router.delete('/:id/emails', auth, c.clearEmails);
router.delete('/:id/emails/:emailId', auth, c.removeEmail);

module.exports = router;
