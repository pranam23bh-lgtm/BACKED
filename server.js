const express = require('express');
const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.static('public'));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/admin.html');
});

app.listen(PORT, () => {
    console.log(`Master Server listening on port ${PORT}`);
});
