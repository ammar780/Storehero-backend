const router = require('express').Router();
const auth = require('../middleware/auth');
const c = require('../controllers/scheduleController');

router.get('/', auth, c.list);
router.post('/', auth, c.scheduleOne);
router.post('/bulk', auth, c.scheduleBulk);
router.get('/:id', auth, c.detail);
router.put('/:id', auth, c.update);
router.post('/:id/cancel', auth, c.cancel);
router.delete('/:id', auth, c.remove);

module.exports = router;
