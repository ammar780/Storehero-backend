const express = require('express');
const auth = require('../middleware/auth');
const { list, detail, remove } = require('../controllers/historyController');

const router = express.Router();

router.get('/', auth, list);
router.get('/:id', auth, detail);
router.delete('/:id', auth, remove);

module.exports = router;
