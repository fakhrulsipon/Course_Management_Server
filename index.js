require('dotenv').config()
const express = require('express')
const app = express()
const cors = require('cors')
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const port = process.env.PORT || 3000

app.use(cors({
  origin: ['https://subscription-box-2faea.web.app', 'http://localhost:5174', 'http://localhost:5173'],
  credentials: true
}));
app.use(express.json())

const admin = require("firebase-admin");
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString('utf8')
const serviceAccount = JSON.parse(decoded);
// console.log(decoded)

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});


const verifyFirebaseToken = async (req, res, next) => {
  const authHeader = req.headers?.authorization;
  const token = authHeader.split(' ')[1]
  if (!token) {
    return res.status(401).send({ message: 'unauthorized access' })
  }
  const userInfo = await admin.auth().verifyIdToken(token)
  req.tokenEmail = userInfo.email;
  // console.log(userInfo)
  next();
}

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
    // await client.connect();
    const courseCollection = client.db("courseDB").collection("courses");
    const enrollmentCollection = client.db("courseDB").collection("enrollments");

    // Get all courses with optional price sorting
    app.get('/courses', async (req, res) => {
      const sortOrder = req.query.sort;
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 5;
      const skip = (page - 1) * limit;

      let sortQuery = {};
      if (sortOrder === 'ascending') {
        sortQuery = { price: 1 }
      }
      else if (sortOrder === 'descending') {
        sortQuery = { price: -1 }
      }

      const totalCourses = await courseCollection.countDocuments();

      // Main query with sort + skip + limit
      const courses = await courseCollection
        .find()
        .sort(sortQuery)
        .skip(skip)
        .limit(limit)
        .toArray();

      res.send({
        total: totalCourses,
        currentPage: page,
        totalPages: Math.ceil(totalCourses / limit),
        courses
      });
    })

    // get 6 latest course
    app.get('/latest-course', async (req, res) => {
      const courses = await courseCollection.find().sort({ createdAt: -1 }).limit(8).toArray();
      res.send(courses)
    })

    // course-details data get
    app.get('/course-details/:id', async (req, res) => {
      const qurey = req.params
      const courseDetails = { _id: new ObjectId(qurey) }
      const result = await courseCollection.findOne(courseDetails)
      res.send(result)
    })

    // check enroll course
    app.get('/check-enroll', async (req, res) => {
      const { email, courseId } = req.query;

      if (!email || !courseId) {
        return res.send({ enrolled: false });
      }

      const exists = await enrollmentCollection.findOne({ email, courseId });

      res.send({ enrolled: exists ? true : false });
    });

    // popular courses
    app.get('/popular-courses', async (req, res) => {
      const popularEnrollments = await enrollmentCollection.aggregate([
        { $group: { _id: "$courseId", enrollCount: { $sum: 1 } } },
        { $sort: { enrollCount: -1 } },
        { $limit: 8 }
      ]).toArray();

      const courseIds = popularEnrollments.map(e => new ObjectId(e._id));
      const courses = await courseCollection.find({ _id: { $in: courseIds } }).toArray();

      const enrollMap = new Map(popularEnrollments.map(e => [e._id.toString(), e.enrollCount]));

      const sortedCourses = courses
        .map(course => ({
          ...course,
          enrollCount: enrollMap.get(course._id.toString()) || 0
        }))
        .sort((a, b) => b.enrollCount - a.enrollCount);

      res.send(sortedCourses);
    });


    // my add course section
    app.get('/my-courses', verifyFirebaseToken, async (req, res) => {
      const email = req.query.email;
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 5;
      const skip = (page - 1) * limit;

      if (req.tokenEmail !== email) {
        return res.status(403).send({ message: 'forbidden access' })
      }

      if (!email) {
        return res.status(400).send({ message: "Email is required" });
      }

      const totalMyCourses = await courseCollection.countDocuments({ instructorEmail: email });

      // skip & limit দিয়ে data আনা
      const userCourses = await courseCollection
        .find({ instructorEmail: email })
        .skip(skip)
        .limit(limit)
        .toArray();

      res.send({
        total: totalMyCourses,
        page,
        limit,
        totalPages: Math.ceil(totalMyCourses / limit),
        courses: userCourses
      });
    });


    // my enrolled courses
    app.get('/enrolled-courses', verifyFirebaseToken, async (req, res) => {
      const email = req.query.email;

      if (req.tokenEmail !== email) {
        return res.status(403).send({ message: 'forbidden access' })
      }

      if (!email) {
        return res.status(400).send({ message: "Email required" });
      }

      const enrolledCourses = await enrollmentCollection.find({ email: email }).toArray();

      const courseIds = enrolledCourses.map(enroll => new ObjectId(enroll.courseId))
      const courses = await courseCollection.find({ _id: { $in: courseIds } }).toArray()
      res.send(courses)
    });

    // add course
    app.post('/add-course', async (req, res) => {
      const courseData = req.body
      courseData.availableSeats = parseInt(courseData.availableSeats) || 0;
      const result = await courseCollection.insertOne(courseData)
      res.send(result)
    })



    //course details a enroll course
    app.post('/enroll', async (req, res) => {
      const { email, courseId } = req.body;

      if (!email || !courseId)
        return res.status(400).send({ message: "Email and courseId are required" });

      const userEnrollments = await enrollmentCollection.find({ email }).toArray();
      const enrolledInThisCourse = userEnrollments.some(enroll => enroll.courseId === courseId);

      if (enrolledInThisCourse) {
        await enrollmentCollection.deleteOne({ email, courseId });
        await courseCollection.updateOne({ _id: new ObjectId(courseId) }, { $inc: { availableSeats: 1 } });
        return res.send({ message: 'Enrollment removed successfully' });
      }

      if (userEnrollments.length > 3)
        return res.status(400).send({ message: 'You can enroll in maximum 3 courses at a time' });

      const course = await courseCollection.findOne({ _id: new ObjectId(courseId) });
      if (!course) return res.status(404).send({ message: 'Course not found' });
      if (course.availableSeats <= 0) return res.status(400).send({ message: 'No seats left in this course' });

      await courseCollection.updateOne({ _id: new ObjectId(courseId) }, { $inc: { availableSeats: -1 } });
      const result = await enrollmentCollection.insertOne({ email, courseId });

      res.send({ message: 'Enrolled successfully', result });
    });


    // update course
    app.put('/update-course/:id', async (req, res) => {
      const id = req.params.id
      const query = { _id: new ObjectId(id) }
      const options = { upsert: true };
      const gardenerTips = req.body

      const updateDoc = {
        $set: gardenerTips
      }

      const result = await courseCollection.updateOne(query, updateDoc, options)
      res.send(result)

    })

    // Delete Course
    app.delete('/delete-course/:id', async (req, res) => {
      const id = req.params.id
      const query = { _id: new ObjectId(id) }
      const result = await courseCollection.deleteOne(query)
      res.send(result)
    })

    // Delete Enrolled
    app.delete('/delete-enrolled/:id/:email', async (req, res) => {
      const id = req.params.id
      const email = req.params.email
      const query = { courseId: id, email }
      const result = await enrollmentCollection.deleteOne(query)
      res.send(result)
    })

    // Send a ping to confirm a successful connection
    // await client.db("admin").command({ ping: 1 });
    // console.log("Pinged your deployment. You successfully connected to MongoDB!");
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