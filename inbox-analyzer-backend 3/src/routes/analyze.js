const express = require('express');
const auth = require('../middleware/auth');
const { analyzeTemplate, analyzeFull } = require('../controllers/analyzeController');

const router = express.Router();

router.post('/template', auth, analyzeTemplate);
router.post('/full', auth, analyzeFull);

module.exports = router;
