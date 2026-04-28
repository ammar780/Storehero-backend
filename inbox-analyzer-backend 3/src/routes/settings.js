const router = require('express').Router();
const auth = require('../middleware/auth');
const c = require('../controllers/settingsController');

router.get('/', auth, c.get);
router.put('/', auth, c.update);
router.delete('/api-key', auth, c.deleteApiKey);
router.post('/test', auth, c.test);

module.exports = router;
