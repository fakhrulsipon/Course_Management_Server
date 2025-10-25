require("dotenv").config();
const { Server } = require("socket.io");
const express = require("express");
const cors = require("cors");
const app = express();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const port = process.env.PORT || 3000;

// CORS configuration - Define ONCE
const allowedOrigins = [
    "https://dynamic-vacherin-e4098b.netlify.app",
    "http://localhost:5174",
    "http://localhost:5173",
];

// Express CORS middleware
app.use(
    cors({
        origin: function (origin, callback) {
            // Allow requests with no origin (like mobile apps or curl requests)
            if (!origin) return callback(null, true);
            if (allowedOrigins.indexOf(origin) === -1) {
                const msg = `The CORS policy for this site does not allow access from the specified Origin: ${origin}`;
                return callback(new Error(msg), false);
            }
            return callback(null, true);
        },
        credentials: true,
    })
);
app.use(express.json());

const httpServer = require("http").createServer(app);
// Socket.io configuration
const io = new Server(httpServer, {
    cors: {
        origin: function (origin, callback) {
            if (!origin || allowedOrigins.indexOf(origin) !== -1) {
                callback(null, true);
            } else {
                callback(new Error('Not allowed by CORS'));
            }
        },
        methods: ["GET", "POST"],
        credentials: true
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000,
    allowEIO3: true // For older clients, if needed
});


const admin = require("firebase-admin");
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf8"
);
const serviceAccount = JSON.parse(decoded);
// console.log(decoded)

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const verifyFirebaseToken = async (req, res, next) => {
  const authHeader = req.headers?.authorization;
  const token = authHeader.split(" ")[1];
  if (!token) {
    return res.status(401).send({ message: "unauthorized access" });
  }
  const userInfo = await admin.auth().verifyIdToken(token);
  req.tokenEmail = userInfo.email;
  // console.log(userInfo)
  next();
};

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.zffyl01.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    // await client.connect();

    const db = client.db("courseDB");
    const courseCollection = db.collection("courses");
    const enrollmentCollection = db.collection("enrollments");
    const reviewCollection = db.collection("reviews");
    const userCollection = db.collection("users");
    const messagesCollection = db.collection("course_messages");

    io.on("connection", (socket) => {
      console.log("A user connected:", socket.id);

      // ইউজার যখন কোর্স রুমে জয়েন করে - CORRECTED VERSION
      socket.on("join_course_room", (data) => {
        try {
          const courseId = data.courseId || data;
          const userEmail = data.userEmail || socket.userData?.userEmail;
          const userRole = data.userRole || socket.userData?.userRole;

          socket.join(courseId);
          socket.userData = { userEmail, userRole, courseId };
          console.log(
            `User ${userEmail} (${userRole}) joined course room: ${courseId}`
          );
        } catch (error) {
          console.error("Error in join_course_room:", error);
        }
      });

      // Admin message event
      socket.on("admin_send_message", async (data) => {
        try {
          console.log("Admin message received:", data);

          const messageData = {
            courseId: data.courseId,
            userEmail: data.userEmail,
            userName: data.userName,
            userPhoto: data.userPhoto,
            message: data.message,
            isAdminMessage: true,
            toUser: data.toUser || null,
            timestamp: new Date(),
          };

          const result = await messagesCollection.insertOne(messageData);
          const savedMessage = { ...messageData, _id: result.insertedId };

          if (data.toUser && data.toUser.trim() !== "") {
            io.to(data.courseId).emit("receive_message", savedMessage);
            console.log(`Message sent to specific user: ${data.toUser}`);
          } else {
            io.to(data.courseId).emit("receive_message", savedMessage);
            console.log(`Broadcast message sent to course: ${data.courseId}`);
          }
        } catch (error) {
          console.error("Error saving admin message:", error);
        }
      });

      // User message event - CORRECTED VERSION
      socket.on("send_message", async (data) => {
        try {
          const { courseId, userEmail, userName, userPhoto, message } = data;

          const user = await userCollection.findOne({ userEmail });
          const isAdmin = user && user.userRole === "admin";

          const messageData = {
            courseId,
            userEmail,
            userName,
            userPhoto,
            message,
            isAdminMessage: isAdmin,
            toUser: null,
            timestamp: new Date(),
          };

          const result = await messagesCollection.insertOne(messageData);
          const savedMessage = { ...messageData, _id: result.insertedId };

          // সবাইকে মেসেজ দেখান (Admin + User)
          io.to(courseId).emit("receive_message", savedMessage);
        } catch (error) {
          console.error("Error saving message:", error);
        }
      });

      socket.on("disconnect", () => {
        console.log("User disconnected:", socket.id);
      });
    });

    // Get messages for a course - শুধুমাত্র অ্যাডমিন এবং মেসেজের মালিক দেখতে পারবে
    app.get(
      "/course-messages/:courseId",
      verifyFirebaseToken,
      async (req, res) => {
        try {
          const { courseId } = req.params;
          const userEmail = req.tokenEmail;

          const user = await userCollection.findOne({ userEmail });
          if (!user) {
            return res.status(404).json({ error: "User not found" });
          }

          let query = { courseId };

          // Admin না হলে শুধুমাত্র প্রাসঙ্গিক মেসেজ দেখাবে
          if (user.userRole !== "admin") {
            query = {
              courseId,
              $or: [
                { userEmail: userEmail }, // নিজের মেসেজ
                {
                  isAdminMessage: true,
                  $or: [{ toUser: null }, { toUser: userEmail }],
                }, // Admin এর সাধারণ বা নিজের জন্য মেসেজ
                { toUser: userEmail }, // নিজের জন্য specifically পাঠানো মেসেজ
              ],
            };
          }

          const messages = await messagesCollection
            .find(query)
            .sort({ timestamp: 1 })
            .limit(100)
            .toArray();

          res.json(messages);
        } catch (error) {
          console.error("Error fetching messages:", error);
          res.status(500).json({ error: "Failed to fetch messages" });
        }
      }
    );

    // Message delete endpoint - শুধুমাত্র অ্যাডমিন বা মেসেজের মালিক ডিলিট করতে পারবে
    app.delete(
      "/course-messages/:messageId",
      verifyFirebaseToken,
      async (req, res) => {
        try {
          const { messageId } = req.params;
          const userEmail = req.tokenEmail; // Firebase token থেকে ইমেল পাবেন

          const db = client.db("courseDB");
          const messagesCollection = db.collection("course_messages");
          const userCollection = db.collection("users");

          // প্রথমে ইউজারের রোল চেক করুন
          const user = await userCollection.findOne({ userEmail: userEmail });
          if (!user) {
            return res.status(404).json({ error: "User not found" });
          }

          // মেসেজ খুঁজে বের করুন
          const message = await messagesCollection.findOne({
            _id: new ObjectId(messageId),
          });

          if (!message) {
            return res.status(404).json({ error: "Message not found" });
          }

          // চেক করুন: ইউজার অ্যাডমিন কি না অথবা মেসেজের মালিক কি না
          if (user.userRole !== "admin" && message.userEmail !== userEmail) {
            return res.status(403).json({
              error: "You are not authorized to delete this message",
            });
          }

          // মেসেজ ডিলিট করুন
          const result = await messagesCollection.deleteOne({
            _id: new ObjectId(messageId),
          });

          // সকেটের মাধ্যমে বাকিদের জানান যে মেসেজ ডিলিট হয়েছে
          io.to(message.courseId).emit("message_deleted", messageId);

          res.json({
            success: true,
            message: "Message deleted successfully",
            result,
          });
        } catch (error) {
          console.error("Error deleting message:", error);
          res.status(500).json({ error: "Failed to delete message" });
        }
      }
    );

    // Get all users in a course
    app.get(
      "/course-users/:courseId",
      verifyFirebaseToken,
      async (req, res) => {
        try {
          const { courseId } = req.params;
          const userEmail = req.tokenEmail;

          // Check if user is admin
          const user = await userCollection.findOne({ userEmail });
          if (!user || user.userRole !== "admin") {
            return res
              .status(403)
              .json({ error: "Access denied. Admin only." });
          }

          // Get distinct users from messages
          const users = await messagesCollection
            .aggregate([
              { $match: { courseId: courseId } },
              {
                $group: {
                  _id: "$userEmail",
                  name: { $first: "$userName" },
                  photoURL: { $first: "$userPhoto" },
                  email: { $first: "$userEmail" },
                  messageCount: { $sum: 1 },
                },
              },
              { $sort: { name: 1 } },
            ])
            .toArray();

          res.json(users);
        } catch (error) {
          console.error("Error fetching course users:", error);
          res.status(500).json({ error: "Failed to fetch users" });
        }
      }
    );

    // Get all courses with optional price sorting
    app.get("/courses", async (req, res) => {
      const sortOrder = req.query.sort;
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 12;
      const skip = (page - 1) * limit;

      const search = req.query.search || "";

      let sortQuery = {};
      if (sortOrder === "ascending") {
        sortQuery = { price: 1 };
      } else if (sortOrder === "descending") {
        sortQuery = { price: -1 };
      }

      const searchQuery = search
        ? { title: { $regex: search, $options: "i" } }
        : {};

      const totalCourses = await courseCollection.countDocuments(searchQuery);

      // Main query with sort + skip + limit
      const courses = await courseCollection
        .find(searchQuery)
        .sort(sortQuery)
        .skip(skip)
        .limit(limit)
        .toArray();

      res.send({
        total: totalCourses,
        currentPage: page,
        totalPages: Math.ceil(totalCourses / limit),
        courses,
      });
    });

    // get 6 latest course
    app.get("/latest-course", async (req, res) => {
      const courses = await courseCollection
        .find()
        .sort({ createdAt: -1 })
        .limit(8)
        .toArray();
      res.send(courses);
    });

    // course-details data get
    app.get("/course-details/:id", async (req, res) => {
      const qurey = req.params;
      const courseDetails = { _id: new ObjectId(qurey) };
      const result = await courseCollection.findOne(courseDetails);
      res.send(result);
    });

    // check enroll course
    app.get("/check-enroll", async (req, res) => {
      const { email, courseId } = req.query;

      if (!email || !courseId) {
        return res.send({ enrolled: false });
      }

      const exists = await enrollmentCollection.findOne({ email, courseId });

      res.send({ enrolled: exists ? true : false });
    });

    // popular courses
    app.get("/popular-courses", async (req, res) => {
      const popularEnrollments = await enrollmentCollection
        .aggregate([
          { $group: { _id: "$courseId", enrollCount: { $sum: 1 } } },
          { $sort: { enrollCount: -1 } },
          { $limit: 8 },
        ])
        .toArray();

      const courseIds = popularEnrollments.map((e) => new ObjectId(e._id));
      const courses = await courseCollection
        .find({ _id: { $in: courseIds } })
        .toArray();

      const enrollMap = new Map(
        popularEnrollments.map((e) => [e._id.toString(), e.enrollCount])
      );

      const sortedCourses = courses
        .map((course) => ({
          ...course,
          enrollCount: enrollMap.get(course._id.toString()) || 0,
        }))
        .sort((a, b) => b.enrollCount - a.enrollCount);

      res.send(sortedCourses);
    });

    // my add course section
    app.get("/my-courses", verifyFirebaseToken, async (req, res) => {
      const email = req.query.email;
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 5;
      const skip = (page - 1) * limit;

      if (req.tokenEmail !== email) {
        return res.status(403).send({ message: "forbidden access" });
      }

      if (!email) {
        return res.status(400).send({ message: "Email is required" });
      }

      const totalMyCourses = await courseCollection.countDocuments({
        instructorEmail: email,
      });

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
        courses: userCourses,
      });
    });

    // my enrolled courses
    app.get("/enrolled-courses", verifyFirebaseToken, async (req, res) => {
      const email = req.query.email;

      if (req.tokenEmail !== email) {
        return res.status(403).send({ message: "forbidden access" });
      }

      if (!email) {
        return res.status(400).send({ message: "Email required" });
      }

      const enrolledCourses = await enrollmentCollection
        .find({ email: email })
        .toArray();

      const courseIds = enrolledCourses.map(
        (enroll) => new ObjectId(enroll.courseId)
      );
      const courses = await courseCollection
        .find({ _id: { $in: courseIds } })
        .toArray();
      res.send(courses);
    });

    // Get reviews for a course
    app.get("/reviews", async (req, res) => {
      try {
        const { courseId } = req.query;

        console.log("Fetching reviews for course:", courseId);

        const reviews = await reviewCollection
          .find({ courseId: courseId })
          .sort({ createdAt: -1 })
          .toArray();

        console.log("Found reviews:", reviews.length);
        res.json(reviews);
      } catch (error) {
        console.error("Error fetching reviews:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch reviews",
        });
      }
    });

    // Get average rating for a course
    app.get("/reviews/average", async (req, res) => {
      try {
        const { courseId } = req.query;

        // console.log("Fetching average rating for course:", courseId);

        const reviews = await reviewCollection
          .find({ courseId: courseId })
          .toArray();

        console.log("Total reviews found:", reviews.length);

        if (reviews.length === 0) {
          return res.json({
            averageRating: 0,
            totalReviews: 0,
          });
        }

        const totalRating = reviews.reduce(
          (sum, review) => sum + review.rating,
          0
        );
        const averageRating = (totalRating / reviews.length).toFixed(1);

        console.log("Calculated average:", averageRating);

        res.json({
          averageRating: parseFloat(averageRating),
          totalReviews: reviews.length,
        });
      } catch (error) {
        console.error("Error calculating average rating:", error);
        res.status(500).json({
          success: false,
          message: "Failed to calculate average rating",
        });
      }
    });

    // get single user role
    app.get("/user-role/:email", async (req, res) => {
      try {
        const user = await userCollection.findOne({
          userEmail: req.params.email,
        });
        res.json({ userRole: user?.userRole || "user" });
      } catch {
        res.json({ userRole: "user" });
      }
    });

    // Admin এর জন্য একটি কোর্সের সব মেসেজ দেখার API
    app.get(
      "/admin/course-messages/:courseId",
      verifyFirebaseToken,
      async (req, res) => {
        try {
          const { courseId } = req.params;
          const userEmail = req.tokenEmail;

          const user = await userCollection.findOne({ userEmail });
          if (!user || user.userRole !== "admin") {
            return res
              .status(403)
              .json({ error: "Access denied. Admin only." });
          }

          const messages = await messagesCollection
            .find({ courseId })
            .sort({ timestamp: 1 })
            .toArray();

          res.json(messages);
        } catch (error) {
          console.error("Error fetching admin messages:", error);
          res.status(500).json({ error: "Failed to fetch messages" });
        }
      }
    );

    // Admin এর জন্য মেসেজ পাঠানোর API
    app.post("/admin/send-message", verifyFirebaseToken, async (req, res) => {
      try {
        const { courseId, userEmail, userName, userPhoto, message, toUser } =
          req.body;

        const adminUser = await userCollection.findOne({ userEmail });
        if (!adminUser || adminUser.userRole !== "admin") {
          return res.status(403).json({ error: "Access denied. Admin only." });
        }

        const messageData = {
          courseId,
          userEmail,
          userName,
          userPhoto,
          message,
          toUser: toUser || null,
          isAdminMessage: true,
          timestamp: new Date(),
        };

        const result = await messagesCollection.insertOne(messageData);
        const savedMessage = { ...messageData, _id: result.insertedId };

        // Socket এর মাধ্যমে মেসেজ পাঠান
        io.to(courseId).emit("receive_message", savedMessage);

        res.json({
          success: true,
          message: "Message sent successfully",
          data: savedMessage,
        });
      } catch (error) {
        console.error("Error sending admin message:", error);
        res.status(500).json({ error: "Failed to send message" });
      }
    });

    // user data save
    app.post("/save-user", async (req, res) => {
      try {
        const { userName, userEmail, userPhoto, userRole = "user" } = req.body;

        // Check if user exists
        const userExists = await userCollection.findOne({ userEmail });
        if (userExists) return res.json({ success: true });

        // Save new user
        await userCollection.insertOne({
          userName,
          userEmail,
          userPhoto: userPhoto || "",
          userRole,
          createdAt: new Date(),
        });

        res.json({ success: true });
      } catch (error) {
        res.json({ success: false });
      }
    });

    // Submit a review
    app.post("/reviews", async (req, res) => {
      try {
        const { courseId, userEmail, userName, userPhoto, rating, comment } =
          req.body;

        console.log("Received review submission:", {
          courseId,
          userEmail,
          rating,
          comment,
        });

        // Validate input
        if (!courseId || !userEmail || !rating || !comment) {
          return res.status(400).json({
            success: false,
            message: "All fields are required",
          });
        }

        // Check if user has already reviewed this course
        const existingReview = await reviewCollection.findOne({
          courseId,
          userEmail,
        });

        if (existingReview) {
          return res.status(400).json({
            success: false,
            message: "You have already reviewed this course",
          });
        }

        // Create new review
        const review = {
          courseId,
          userEmail,
          userName,
          userPhoto,
          rating: parseInt(rating),
          comment: comment.trim(),
          createdAt: new Date(),
        };

        console.log("Inserting review:", review);

        const result = await reviewCollection.insertOne(review);

        console.log("Review inserted successfully:", result.insertedId);

        res.json({
          success: true,
          message: "Review submitted successfully",
          review: {
            ...review,
            _id: result.insertedId,
          },
        });
      } catch (error) {
        console.error("Error submitting review:", error);
        res.status(500).json({
          success: false,
          message: "Failed to submit review",
        });
      }
    });

    // add course
    app.post("/add-course", async (req, res) => {
      const courseData = req.body;
      courseData.availableSeats = parseInt(courseData.availableSeats) || 0;
      const result = await courseCollection.insertOne(courseData);
      res.send(result);
    });

    //course details a enroll course
    app.post("/enroll", async (req, res) => {
      const { email, courseId } = req.body;

      if (!email || !courseId)
        return res
          .status(400)
          .send({ message: "Email and courseId are required" });

      const userEnrollments = await enrollmentCollection
        .find({ email })
        .toArray();
      const enrolledInThisCourse = userEnrollments.some(
        (enroll) => enroll.courseId === courseId
      );

      if (enrolledInThisCourse) {
        await enrollmentCollection.deleteOne({ email, courseId });
        await courseCollection.updateOne(
          { _id: new ObjectId(courseId) },
          { $inc: { availableSeats: 1 } }
        );
        return res.send({ message: "Enrollment removed successfully" });
      }

      if (userEnrollments.length > 3)
        return res
          .status(400)
          .send({ message: "You can enroll in maximum 3 courses at a time" });

      const course = await courseCollection.findOne({
        _id: new ObjectId(courseId),
      });
      if (!course) return res.status(404).send({ message: "Course not found" });
      if (course.availableSeats <= 0)
        return res
          .status(400)
          .send({ message: "No seats left in this course" });

      await courseCollection.updateOne(
        { _id: new ObjectId(courseId) },
        { $inc: { availableSeats: -1 } }
      );
      const result = await enrollmentCollection.insertOne({ email, courseId });

      res.send({ message: "Enrolled successfully", result });
    });

    // update course
    app.put("/update-course/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const options = { upsert: true };
      const gardenerTips = req.body;

      const updateDoc = {
        $set: gardenerTips,
      };

      const result = await courseCollection.updateOne(
        query,
        updateDoc,
        options
      );
      res.send(result);
    });

    // Delete Course
    app.delete("/delete-course/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await courseCollection.deleteOne(query);
      res.send(result);
    });

    // Delete Enrolled
    app.delete("/delete-enrolled/:id/:email", async (req, res) => {
      const id = req.params.id;
      const email = req.params.email;
      const query = { courseId: id, email };
      const result = await enrollmentCollection.deleteOne(query);
      res.send(result);
    });

    // Send a ping to confirm a successful connection
    // await client.db("admin").command({ ping: 1 });
    // console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Welcome to the Course Management System API");
});

httpServer.listen(port, () => {
  console.log(`Course Management System server is running on port ${port}`);
});

