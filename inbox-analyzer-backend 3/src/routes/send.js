const router = require('express').Router();
const auth = require('../middleware/auth');
const c = require('../controllers/sendController');

router.post('/', auth, c.start);
router.get('/jobs', auth, c.listJobs);
router.get('/jobs/:id', auth, c.jobDetail);
router.get('/jobs/:id/recipients', auth, c.jobRecipients);
router.post('/jobs/:id/cancel', auth, c.cancelJob);

module.exports = router;
