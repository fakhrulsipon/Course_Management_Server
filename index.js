const express = require('express')
const app = express()
const cors = require('cors')
const port = process.env.PORT || 3000

app.use(cors())
app.use(express.json())

app.get('/', (req, res) => {
  res.send('Welcome to the Course Management System API')
})

app.listen(port, () => {
  console.log(`Course Management System server is running on port ${port}`)
})