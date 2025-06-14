require('dotenv').config()
const express = require('express')
const app = express()
const cors = require('cors')
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const port = process.env.PORT || 3000

app.use(cors())
app.use(express.json())

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.zffyl01.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();
    const courseCollection = client.db("courseDB").collection("courses");
    const enrollmentCollection = client.db("courseDB").collection("enrollments");

    // get 6 latest course
    app.get('/latest-course', async (req, res) => {
      const courses = await courseCollection.find().sort({ createdAt: -1 }).limit(6).toArray();
      res.send(courses)
    })

    // course-details data get
    app.get('/course-details/:id', async (req, res) => {
      const qurey = req.params
      const courseDetails = { _id: new ObjectId(qurey) }
      const result = await courseCollection.findOne(courseDetails)
      res.send(result)
    })
    
    // check enroll part
    app.get('/check-enroll', async (req, res) => {
      const { email, courseId } = req.query;

      if (!email || !courseId) {
        return res.send({ enrolled: false });
      }

      const exists = await enrollmentCollection.findOne({ email, courseId });

      res.send({ enrolled: exists ? true : false });
    });

    // add course
    app.post('/add-course', async (req, res) => {
      const courseData = req.body
      const result = await courseCollection.insertOne(courseData)
      res.send(result)
    })

    // enroll course
    app.post('/enroll', async (req, res) => {
      const enrollmentData = req.body;

      const exists = await enrollmentCollection.findOne({
        email: enrollmentData.email,
        courseId: enrollmentData.courseId
      });

      if (exists) {
        return res.status(400).send({ message: 'Already Enrolled' });
      }

      const result = await enrollmentCollection.insertOne(enrollmentData);
      res.send(result);
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {

  }
}
run().catch(console.dir);


app.get('/', (req, res) => {
  res.send('Welcome to the Course Management System API')
})

app.listen(port, () => {
  console.log(`Course Management System server is running on port ${port}`)
})