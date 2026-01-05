const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

dotenv.config();

// Check if JWT_SECRET is set
if (!process.env.JWT_SECRET) {
    console.error('\n❌ ERROR: JWT_SECRET is not defined in .env file!');
    console.error('📝 Please create a .env file with JWT_SECRET');
    console.error('💡 Run: create-env.bat (Windows) or ./create-env.sh (Mac/Linux)\n');
    process.exit(1);
}

// Email transporter setup
let transporter = null;
if (process.env.EMAIL_HOST && process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    transporter = nodemailer.createTransport({
        host: process.env.EMAIL_HOST,
        port: process.env.EMAIL_PORT || 587,
        secure: process.env.EMAIL_PORT == 465, // true for 465, false for other ports
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS
        }
    });
    console.log('✅ Email service configured');
} else {
    console.log('⚠️  Email configuration not found. Email sending will be disabled.');
    console.log('   To enable email, add EMAIL_HOST, EMAIL_USER, EMAIL_PASS to .env file');
}

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));
app.use('/images', express.static(path.join(__dirname, 'images')));

// Database connection
mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
})
.then(() => console.log('MongoDB connected'))
.catch(err => console.log('MongoDB connection error:', err));

// Models
const User = require('./models/User');
const Bus = require('./models/Bus');
const Booking = require('./models/Booking');

// Authentication middleware
const authenticateToken = (req, res, next) => {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Access denied. Please login again.' });

    try {
        const verified = jwt.verify(token, process.env.JWT_SECRET);
        req.user = verified;
        next();
    } catch (err) {
        // Clear invalid token and ask user to login again
        return res.status(401).json({ 
            error: 'Session expired. Please login again.',
            expired: true 
        });
    }
};

// Generate ticket ID
const generateTicketId = () => {
    return 'TICKET' + Date.now() + Math.floor(Math.random() * 1000);
};

// Date-only UTC function
function dateOnlyUTC(dateStr) {
  const d = new Date(dateStr); // '2025-12-23' or ISO
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), 0,0,0));
}

// Parse time string to minutes for sorting (e.g., "10:00 PM" -> 1320 minutes)
function parseTimeToMinutes(timeStr) {
    if (!timeStr) return 0;
    const timeRegex = /(\d{1,2}):(\d{2})\s*(AM|PM)/i;
    const match = timeStr.match(timeRegex);
    if (!match) return 0;
    
    let hours = parseInt(match[1]);
    const minutes = parseInt(match[2]);
    const period = match[3].toUpperCase();
    
    if (period === 'PM' && hours !== 12) {
        hours += 12;
    } else if (period === 'AM' && hours === 12) {
        hours = 0;
    }
    
    return hours * 60 + minutes;
}

// Send ticket email to passenger
async function sendTicketEmail(booking, bus, user) {
    if (!transporter) {
        console.log('Email not configured, skipping email send');
        return;
    }

    try {
        const journeyDate = booking.journeyDateISO || (bus.departureDate ? new Date(bus.departureDate).toISOString().split('T')[0] : '');
        const depTime = booking.departureTimeSnapshot || bus.departureTime || '';
        const arrTime = booking.arrivalTimeSnapshot || bus.arrivalTime || '';
        
        // Create HTML email template
        const emailHTML = `
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                    .header { background: linear-gradient(135deg, #48bb78 0%, #2f855a 100%); color: white; padding: 20px; border-radius: 10px 10px 0 0; text-align: center; }
                    .content { background: #f7fafc; padding: 30px; border-radius: 0 0 10px 10px; }
                    .ticket-box { background: white; padding: 20px; border-radius: 10px; margin: 20px 0; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                    .ticket-id { font-size: 24px; font-weight: bold; color: #2f855a; margin-bottom: 10px; }
                    .info-row { margin: 15px 0; padding: 10px; background: #f0fff4; border-left: 4px solid #2f855a; }
                    .label { font-weight: bold; color: #4a5568; }
                    .value { color: #2d3748; }
                    .passenger-table { width: 100%; border-collapse: collapse; margin: 20px 0; }
                    .passenger-table th { background: #2f855a; color: white; padding: 12px; text-align: left; }
                    .passenger-table td { padding: 10px; border-bottom: 1px solid #e2e8f0; }
                    .footer { text-align: center; margin-top: 30px; color: #666; font-size: 12px; }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="header">
                        <h1>🎫 Bus Ticket Confirmed</h1>
                        <p>Your booking has been successfully confirmed!</p>
                    </div>
                    <div class="content">
                        <div class="ticket-box">
                            <div class="ticket-id">Ticket ID: ${booking.ticketId}</div>
                            
                            <div class="info-row">
                                <div class="label">Bus Details:</div>
                                <div class="value">${bus.busName} (${bus.busNumber})</div>
                            </div>
                            
                            <div class="info-row">
                                <div class="label">Route:</div>
                                <div class="value">${bus.from} → ${bus.to}</div>
                            </div>
                            
                            <div class="info-row">
                                <div class="label">Journey Date:</div>
                                <div class="value">${journeyDate ? new Date(journeyDate).toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : 'N/A'}</div>
                            </div>
                            
                            <div class="info-row">
                                <div class="label">Departure Time:</div>
                                <div class="value">${depTime}</div>
                            </div>
                            
                            <div class="info-row">
                                <div class="label">Arrival Time:</div>
                                <div class="value">${arrTime}</div>
                            </div>
                            
                            <div class="info-row">
                                <div class="label">Total Amount:</div>
                                <div class="value">₹${booking.totalAmount}</div>
                            </div>
                            
                            <div class="info-row">
                                <div class="label">Payment Method:</div>
                                <div class="value">${booking.paymentMethod.toUpperCase()}</div>
                            </div>
                            
                            <h3 style="margin-top: 30px; color: #2f855a;">Passenger Details</h3>
                            <table class="passenger-table">
                                <thead>
                                    <tr>
                                        <th>Seat</th>
                                        <th>Name</th>
                                        <th>Age</th>
                                        <th>Gender</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${booking.seats.map(seat => `
                                        <tr>
                                            <td>${seat.seatNumber}</td>
                                            <td>${seat.passengerName || '-'}</td>
                                            <td>${seat.passengerAge || '-'}</td>
                                            <td>${seat.passengerGender || '-'}</td>
                                        </tr>
                                    `).join('')}
                                </tbody>
                            </table>
                            
                            <div style="margin-top: 30px; padding: 15px; background: #fff5f5; border-radius: 8px; border-left: 4px solid #f56565;">
                                <strong>Important Instructions:</strong>
                                <ul style="margin: 10px 0; padding-left: 20px;">
                                    <li>Please arrive at the bus station 30 minutes before departure time</li>
                                    <li>Carry a valid ID proof for verification</li>
                                    <li>This ticket is non-transferable</li>
                                    <li>For cancellations, you can cancel through "My Bookings" section</li>
                                </ul>
                            </div>
                        </div>
                        
                        <div class="footer">
                            <p>Thank you for choosing our bus booking service!</p>
                            <p>For support, please contact us at ${process.env.EMAIL_USER || 'support@busbooking.com'}</p>
                        </div>
                    </div>
                </div>
            </body>
            </html>
        `;

        // Send email
        // FROM: Admin's email (configured in .env) - this is just the sender account
        // TO: Passenger's email (from booking form) - each passenger receives their own ticket
        const passengerEmail = booking.passengerDetails.email || user.email;
        const mailOptions = {
            from: `"Bus Booking System" <${process.env.EMAIL_USER}>`,
            to: passengerEmail,  // Email goes to passenger's email address, not admin's
            subject: `🎫 Bus Ticket Confirmed - ${booking.ticketId}`,
            html: emailHTML,
            text: `Your bus ticket has been confirmed!\n\nTicket ID: ${booking.ticketId}\nBus: ${bus.busName} (${bus.busNumber})\nRoute: ${bus.from} to ${bus.to}\nJourney Date: ${journeyDate}\nDeparture: ${depTime}\nTotal Amount: ₹${booking.totalAmount}\n\nThank you for your booking!`
        };

        await transporter.sendMail(mailOptions);
        console.log(`✅ Ticket email sent FROM ${process.env.EMAIL_USER} TO ${passengerEmail}`);
    } catch (error) {
        console.error('❌ Error sending email:', error);
        // Don't throw error - email failure shouldn't break booking
    }
}

// Routes

// Validation functions
function validateMobile(mobile) {
    // Indian mobile number: 10 digits starting with 6-9
    const mobileRegex = /^[6-9]\d{9}$/;
    return mobileRegex.test(String(mobile).replace(/\s+/g, ''));
}

function validateEmail(email) {
    // Email validation: must contain @ and valid domain
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    return emailRegex.test(String(email));
}

function validateAge(age) {
    const ageNum = parseInt(age);
    return !isNaN(ageNum) && ageNum >= 1 && ageNum <= 120;
}

function validateUPI(upiId) {
    // UPI ID format: name@provider (e.g., name@paytm, name@phonepe, name@ybl, name@okaxis)
    const upiRegex = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/;
    return upiRegex.test(String(upiId));
}

// 1. User Registration
app.post('/api/register', async (req, res) => {
    try {
        const { name, email, mobile, password } = req.body;
        
        // Validate email
        if (!email || !validateEmail(email)) {
            return res.status(400).json({ error: 'Invalid email address. Must contain @ and a valid domain (e.g., name@example.com)' });
        }
        
        // Validate mobile number
        if (!mobile || !validateMobile(mobile)) {
            return res.status(400).json({ error: 'Invalid mobile number. Must be 10 digits starting with 6-9' });
        }
        
        // Check if user exists
        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(400).json({ error: 'User already exists' });
        }

        // Create new user
        const user = new User({ name, email, mobile, password });
        await user.save();

        // Generate token
        const token = jwt.sign(
            { userId: user._id, email: user.email },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        res.status(201).json({
            message: 'Registration successful',
            token,
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                mobile: user.mobile
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 2. User Login
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        // Find user
        const user = await User.findOne({ email });
        if (!user) {
            return res.status(400).json({ error: 'Invalid credentials' });
        }

        // Check password
        const isMatch = await user.comparePassword(password);
        if (!isMatch) {
            return res.status(400).json({ error: 'Invalid credentials' });
        }

        // Generate token
        const token = jwt.sign(
            { userId: user._id, email: user.email },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        res.json({
            message: 'Login successful',
            token,
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                mobile: user.mobile
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 3. Search buses with future dates only
app.get('/api/search-buses', async (req, res) => {
    try {
        const { from, to, date } = req.query;

        if (!from || !to || !date) {
            return res.status(400).json({ error: 'Missing query parameters. Please provide from, to and date.' });
        }

        // parse date as date-only UTC midnight to avoid timezone issues
        const start = dateOnlyUTC(date);
        if (isNaN(start.getTime())) {
            return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD or ISO date.' });
        }

        const today = dateOnlyUTC(new Date().toISOString().split('T')[0]);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        const maxDate = new Date(today);
        maxDate.setDate(maxDate.getDate() + 90);
        
        // Exclude today - only allow dates from tomorrow onwards
        if (start <= today) {
            return res.status(400).json({ error: 'Please select a date from tomorrow onwards. Today\'s date is not allowed.' });
        }
        
        // Limit to 90 days in future
        if (start > maxDate) {
            return res.status(400).json({ error: 'Booking date cannot be more than 90 days in the future' });
        }

        const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

        // Case-insensitive search with trim - works with any combination
        const fromRegex = new RegExp(String(from).trim(), 'i');
        const toRegex = new RegExp(String(to).trim(), 'i');

        // after computing `start` and `end` (UTC midnight range)
        let buses = await Bus.find({
          from: fromRegex,
          to: toRegex,
          isActive: true,
          $or: [
            { departureDate: { $gte: start, $lt: end } }, // specific-date buses
            { departureDate: { $exists: false } },        // recurring buses (no date)
            { departureDate: null }                       // or explicit null
          ]
        }).select('-seats').lean();

        // Sort buses by departure time (earliest first)
        // Convert time string to comparable format (e.g., "10:00 PM" -> 22:00)
        buses.sort((a, b) => {
            const timeA = parseTimeToMinutes(a.departureTime);
            const timeB = parseTimeToMinutes(b.departureTime);
            return timeA - timeB;
        });

        res.json(buses);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 3.5. Get available routes for autocomplete
app.get('/api/available-routes', async (req, res) => {
    try {
        // Get all unique "from" and "to" locations from active buses
        const fromLocations = await Bus.distinct('from', { isActive: true });
        const toLocations = await Bus.distinct('to', { isActive: true });
        
        // Sort alphabetically
        const sortedFrom = fromLocations.sort();
        const sortedTo = toLocations.sort();
        
        res.json({
            from: sortedFrom,
            to: sortedTo
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 4. Get bus details with seat status
app.get('/api/bus/:id', async (req, res) => {
    try {
        const bus = await Bus.findById(req.params.id);
        if (!bus) {
            return res.status(404).json({ error: 'Bus not found' });
        }
        // Add a date-only ISO string to avoid timezone shifts on the client
        const busObj = bus.toObject();
        if (req.query.date) {
            const parsed = new Date(req.query.date);
            if (!isNaN(parsed.getTime())) {
                busObj.departureDateISO = parsed.toISOString().split('T')[0];
            } else if (busObj.departureDate) {
                busObj.departureDateISO = new Date(busObj.departureDate).toISOString().split('T')[0];
            }
        } else if (busObj.departureDate) {
            busObj.departureDateISO = new Date(busObj.departureDate).toISOString().split('T')[0];
        }

        res.json(busObj);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
app.post('/api/book-seats', authenticateToken, async (req, res) => {
    try {
        const { busId, seats, passengerDetails, paymentMethod, journeyDate, upiId } = req.body;
        
        // Validate passenger details
        for (const seat of seats) {
            if (!seat.passengerName || !seat.passengerName.trim()) {
                return res.status(400).json({ error: `Passenger name is required for seat ${seat.seatNumber}` });
            }
            if (!seat.passengerAge || !validateAge(seat.passengerAge)) {
                return res.status(400).json({ error: `Valid age (1-120) is required for seat ${seat.seatNumber}` });
            }
            if (!seat.passengerGender) {
                return res.status(400).json({ error: `Gender is required for seat ${seat.seatNumber}` });
            }
        }
        
        // Validate contact mobile
        if (!passengerDetails || !passengerDetails.mobile || !validateMobile(passengerDetails.mobile)) {
            return res.status(400).json({ error: 'Invalid contact mobile number. Must be 10 digits starting with 6-9' });
        }
        
        // Validate contact email
        if (!passengerDetails || !passengerDetails.email || !validateEmail(passengerDetails.email)) {
            return res.status(400).json({ error: 'Invalid contact email address. Must contain @ and a valid domain (e.g., name@example.com)' });
        }
        
        // Validate UPI ID if payment method is UPI
        if (paymentMethod === 'upi') {
            if (!upiId || !validateUPI(upiId)) {
                return res.status(400).json({ error: 'Invalid UPI ID format. Use: name@provider (e.g., name@paytm, name@phonepe)' });
            }
        }
        
        // Get bus
        const bus = await Bus.findById(busId);
        if (!bus) {
            return res.status(404).json({ error: 'Bus not found' });
        }

        // Check if seats are available
        for (const seat of seats) {
            const busSeat = bus.seats.find(s => s.seatNumber === seat.seatNumber);
            if (busSeat && busSeat.isBooked) {
                return res.status(400).json({ error: `Seat ${seat.seatNumber} is already booked` });
            }
        }

        // Generate ticket ID
        const ticketId = generateTicketId();

        // Calculate total amount
        const totalAmount = seats.length * bus.price;

        // Determine journey date: prefer client-selected `journeyDate`, fallback to bus.departureDate
        let journeyDateVal = null;
        let journeyDateISO = undefined;
        if (journeyDate) {
            const parsed = new Date(journeyDate);
            if (isNaN(parsed.getTime())) {
                return res.status(400).json({ error: 'Invalid journeyDate' });
            }
            journeyDateVal = parsed;
            journeyDateISO = parsed.toISOString().split('T')[0];
        } else if (bus.departureDate) {
            journeyDateVal = bus.departureDate;
            journeyDateISO = new Date(bus.departureDate).toISOString().split('T')[0];
        }

        // Create booking and snapshot journey date/time to avoid later mismatches
        const booking = new Booking({
            ticketId,
            user: req.user.userId,
            bus: busId,
            seats,
            totalAmount,
            passengerDetails,
            paymentMethod,
            status: 'confirmed',
            journeyDate: journeyDateVal,
            journeyDateISO: journeyDateISO,
            departureTimeSnapshot: bus.departureTime,
            arrivalTimeSnapshot: bus.arrivalTime
        });

        await booking.save();

        // Update bus seats
        for (const seat of seats) {
            const seatIndex = bus.seats.findIndex(s => s.seatNumber === seat.seatNumber);
            if (seatIndex !== -1) {
                bus.seats[seatIndex].isBooked = true;
                bus.seats[seatIndex].bookedBy = req.user.userId;
            }
        }
        
        bus.availableSeats -= seats.length;
        await bus.save();

        // Populate bus and user for email
        await booking.populate('bus');
        await booking.populate('user', 'name email');

        // Send ticket email to passenger (async, don't wait)
        sendTicketEmail(booking, booking.bus, booking.user).catch(err => {
            console.error('Email sending failed:', err);
        });

        res.status(201).json({
            message: 'Booking successful',
            ticketId: booking.ticketId,
            booking
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 6. Get user bookings
app.get('/api/my-bookings', authenticateToken, async (req, res) => {
    try {
        const bookings = await Booking.find({ user: req.user.userId })
            .populate('bus', 'busName busNumber from to departureTime arrivalTime departureDate image')
            .sort({ bookingDate: -1 });
        res.json(bookings);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 7. Cancel ticket with 80% refund
app.post('/api/cancel-ticket', authenticateToken, async (req, res) => {
    try {
        const { ticketId } = req.body;

        const booking = await Booking.findOne({ 
            ticketId, 
            user: req.user.userId 
        }).populate('bus');

        if (!booking) {
            return res.status(404).json({ error: 'Booking not found' });
        }

        if (booking.isCancelled) {
            return res.status(400).json({ error: 'Ticket already cancelled' });
        }

        // Calculate 80% refund
        const refundAmount = booking.totalAmount * 0.8;

        // Update booking
        booking.isCancelled = true;
        booking.status = 'cancelled';
        booking.paymentStatus = 'refunded';
        booking.refundAmount = refundAmount;
        booking.cancellationDate = new Date();
        await booking.save();

        // Update bus seats
        const bus = await Bus.findById(booking.bus._id);
        for (const seat of booking.seats) {
            const seatIndex = bus.seats.findIndex(s => s.seatNumber === seat.seatNumber);
            if (seatIndex !== -1) {
                bus.seats[seatIndex].isBooked = false;
                bus.seats[seatIndex].bookedBy = null;
            }
        }
        
        bus.availableSeats += booking.seats.length;
        await bus.save();

        res.json({
            message: 'Ticket cancelled successfully',
            refundAmount,
            cancellationDate: booking.cancellationDate
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


// 8. Download ticket as PDF
app.get('/api/download-ticket/:ticketId',async (req, res) => {
    try {
        // Get token from query parameter for download (since window.open can't send headers)
        const token = req.query.token || req.headers['authorization']?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ error: 'Access denied' });
        }

        let verified;
        try {
            verified = jwt.verify(token, process.env.JWT_SECRET);
        } catch (err) {
            return res.status(400).json({ error: 'Invalid token' });
        }

        const booking = await Booking.findOne({ 
            ticketId: req.params.ticketId,
            user: verified.userId 
        }).populate('bus').populate('user', 'name email mobile');

        if (!booking) {
            return res.status(404).json({ error: 'Ticket not found' });
        }

        // Create PDF
        const doc = new PDFDocument({ margin: 50 });
        
        // Set response headers
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=ticket-${booking.ticketId}.pdf`);

        doc.pipe(res);
 // Register Tamil font if available (for proper Tamil text rendering)
        // Priority: Project fonts folder first, then Windows system fonts
        let tamilFontRegistered = false;
        let tamilFontName = 'Helvetica'; // Default fallback
        
        // First, check project fonts folder
        const projectFontsDir = path.join(__dirname, 'fonts');
        if (fs.existsSync(projectFontsDir)) {
            const projectFonts = fs.readdirSync(projectFontsDir);
            const tamilProjectFonts = projectFonts.filter(f => {
                const lower = f.toLowerCase();
                return lower.includes('tamil') || lower.includes('latha') || lower.includes('nirmala');
            });
            
            for (const fontFile of tamilProjectFonts) {
                const fontPath = path.join(projectFontsDir, fontFile);
                try {
                    if (fs.existsSync(fontPath)) {
                        doc.registerFont('TamilFont', fontPath);
                        tamilFontName = 'TamilFont';
                        tamilFontRegistered = true;
                        console.log('✅ Tamil font registered from project:', fontPath);
                        break;
                    }
                } catch (err) {
                    console.log('Could not register project font:', fontPath, err.message);
                }
            }
        }
        
        // If project font not found, try Windows system fonts
        if (!tamilFontRegistered) {
            const windowsFontsDir = 'C:\\Windows\\Fonts';
            if (fs.existsSync(windowsFontsDir)) {
                try {
                    const systemFonts = fs.readdirSync(windowsFontsDir);
                    // Priority order: Latha, Nirmala, then any Tamil font
                    const fontPriority = [
                        f => f.toLowerCase() === 'latha.ttf',
                        f => f.toLowerCase() === 'nirmala.ttf',
                        f => f.toLowerCase().includes('latha'),
                        f => f.toLowerCase().includes('nirmala'),
                        f => f.toLowerCase().includes('tamil')
                    ];
                    
                    for (const priorityCheck of fontPriority) {
                        const matchingFont = systemFonts.find(priorityCheck);
                        if (matchingFont) {
                            const fontPath = path.join(windowsFontsDir, matchingFont);
                            try {
                                doc.registerFont('TamilFont', fontPath);
                                tamilFontName = 'TamilFont';
                                tamilFontRegistered = true;
                                console.log('✅ Tamil font registered from system:', fontPath);
                                break;
                            } catch (err) {
                                console.log('Could not register system font:', fontPath, err.message);
                            }
                        }
                    }
                } catch (err) {
                    console.log('Error reading Windows Fonts directory:', err.message);
                }
            }
        }
        
        if (!tamilFontRegistered) {
            console.log('⚠️  No Tamil font found. Tamil text may display as garbled characters.');
            console.log('   Run: node check-tamil-fonts.js to check available fonts');
        }
        // Styled ticket layout: header, bus image, two-column details (bus info & passenger info), payment box, instructions
        const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

        // Header
        const headerHeight = 64;
        doc.rect(doc.x, doc.y, pageWidth, headerHeight).fill('#28a745');
        doc.fillColor('white').fontSize(18).text('Geobus booking', doc.x + 12, doc.y + 16);
        doc.fillColor('white').fontSize(10).text(`Booking ID: ${booking.ticketId}`, doc.x + 12, doc.y + 38);

        // Reserve space for header and set content start Y
        const contentTop = doc.page.margins.top + headerHeight + 12;

        // Center bus image horizontally
        const imageMaxWidth = pageWidth * 0.60; // 60% of page width
        const imageMaxHeight = 150;
        const busImagePath = booking.bus && booking.bus.image ? path.join(__dirname, booking.bus.image) : null;

        // Draw bus image centered if available
        if (busImagePath && fs.existsSync(busImagePath)) {
            try {
                const imageX = doc.x + (pageWidth - imageMaxWidth) / 2; // Perfectly centered
                doc.image(busImagePath, imageX, contentTop, { fit: [imageMaxWidth, imageMaxHeight], align: 'center' });
            } catch (err) {
                console.log('Could not add bus image to PDF:', err);
            }
        }

        // Move cursor below image
        const afterImagesY = contentTop + imageMaxHeight + 12;
        doc.y = afterImagesY;

        // Two-column layout for bus info (left) and passenger info (right)
        const depDateISO = booking.journeyDateISO || (booking.bus && booking.bus.departureDate ? new Date(booking.bus.departureDate).toISOString().split('T')[0] : '');
        const bookingDateISO = booking.bookingDate ? new Date(booking.bookingDate).toISOString().split('T')[0] : '';
        const passengerAge = booking.seats && booking.seats.length > 0 && booking.seats[0].passengerAge ? booking.seats[0].passengerAge : '-';
        const seatNumbers = booking.seats && booking.seats.length > 0 ? booking.seats.map(s => s.seatNumber).join(', ') : '-';

        const colGap = 20;
        const colWidth = (pageWidth - colGap) / 2;
        const leftColX = doc.x;
        const rightColX = doc.x + colWidth + colGap;
        const startY = afterImagesY;

        // Left column: Bus Information
        let leftCursorY = startY;
        doc.fontSize(13).fillColor('#000').font('Helvetica-Bold').text('Bus Information', leftColX, leftCursorY);
        leftCursorY += 18;
        doc.fontSize(11).fillColor('#444').font('Helvetica');
        doc.text(`Bus Name: ${booking.bus.busName}`, leftColX, leftCursorY);
        leftCursorY += 16;
        doc.text(`Bus Number: ${booking.bus.busNumber}`, leftColX, leftCursorY);
        leftCursorY += 16;
        doc.text(`Journey Date: ${depDateISO}`, leftColX, leftCursorY);
        leftCursorY += 16;
        doc.text(`Booking Date: ${bookingDateISO}`, leftColX, leftCursorY);
        leftCursorY += 16;
        doc.text(`Payment Status: ${(booking.paymentStatus || booking.status || 'completed').toUpperCase()}`, leftColX, leftCursorY);
        leftCursorY += 16;
        doc.text(`Payment ID: ${booking.ticketId}`, leftColX, leftCursorY);

        // Right column: Passenger Information
        let rightCursorY = startY;
        doc.fontSize(13).fillColor('#000').font('Helvetica-Bold').text('Passenger Information', rightColX, rightCursorY);
        rightCursorY += 18;
        doc.fontSize(11).fillColor('#444').font('Helvetica');
        doc.text(`Name: ${booking.user.name}`, rightColX, rightCursorY);
        rightCursorY += 16;
        doc.text(`Seat Number: ${seatNumbers}`, rightColX, rightCursorY);
        rightCursorY += 16;
        doc.text(`Age: ${passengerAge}`, rightColX, rightCursorY);
        rightCursorY += 16;
        doc.text(`Mobile: ${booking.user.mobile}`, rightColX, rightCursorY);
        rightCursorY += 16;
        doc.text(`Email: ${booking.user.email}`, rightColX, rightCursorY);

        // Move cursor to the maximum Y position of both columns
        const maxY = Math.max(leftCursorY, rightCursorY) + 10;
        doc.y = maxY;

        // Draw a divider - full width
        doc.moveTo(leftColX, doc.y).lineTo(leftColX + pageWidth, doc.y).strokeColor('#e0e0e0').stroke();
        doc.moveDown(0.8);

        // Payment box - aligned with left column
        const boxY = doc.y;
        const boxWidth = 220;
        doc.roundedRect(leftColX, boxY, boxWidth, 60, 6).stroke('#28a745');
        doc.fontSize(11).fillColor('#000').font('Helvetica-Bold').text('Payment Details', leftColX + 8, boxY + 8);
        doc.font('Helvetica').fontSize(11).fillColor('#444').text(`Total: ₹${booking.totalAmount}`, leftColX + 8, boxY + 24);
        doc.text(`Method: ${booking.paymentMethod.toUpperCase()}`, leftColX + 8, boxY + 40);
        doc.text(`Status: ${booking.status.toUpperCase()}`, leftColX + 110, boxY + 40);

        // Cancellation/refund info
        if (booking.isCancelled) {
            doc.fillColor('red').fontSize(11).text(`Refund: ₹${booking.refundAmount}`, leftColX + boxWidth + 20, boxY + 24);
            doc.fillColor('#444').text(`Cancelled on: ${booking.cancellationDate.toLocaleDateString()}`, leftColX + boxWidth + 20, boxY + 40);
        }

        // Move cursor below payment box
        doc.y = boxY + 68;
        doc.moveDown(0.6);

        // Draw a divider before instructions - full width
        doc.moveTo(leftColX, doc.y).lineTo(leftColX + pageWidth, doc.y).strokeColor('#e0e0e0').stroke();
        doc.moveDown(0.6);

        // Detailed Instructions Section - aligned with left column
        doc.fontSize(12).fillColor('#000').font('Helvetica-Bold').text('Important Instructions', leftColX, doc.y);
        doc.moveDown(0.5);
        
        const instructions = [
            '• Arrive at boarding point 30 minutes before departure time',
            '• Carry any government ID card (Aadhar/Driving License/Passport)',
            '• This ticket is non-transferable',
            '• Contact support for any changes or cancellations',
            '• Keep this ticket safe for your journey',
            '• Boarding point details will be sent via SMS/Email'
        ];

        doc.fontSize(10).fillColor('#444').font('Helvetica');
        instructions.forEach(instruction => {
            doc.text(instruction, leftColX, doc.y, { width: pageWidth });
            doc.moveDown(0.4);
        });

        doc.end();
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 9. Get QR code for payment (using your original image)
app.get('/api/payment-qr', (req, res) => {
    // Serve your original QR code image
    res.sendFile(path.join(__dirname, 'images', 'payment-qr.png'));
});

// 10. Initialize bus seats
app.post('/api/initialize-bus/:id', async (req, res) => {
    try {
        const bus = await Bus.findById(req.params.id);
        if (!bus) {
            return res.status(404).json({ error: 'Bus not found' });
        }

        // Initialize 40 seats if not already initialized
        if (bus.seats.length === 0) {
            for (let i = 1; i <= 40; i++) {
                bus.seats.push({
                    seatNumber: `S${i.toString().padStart(2, '0')}`,
                    isBooked: false
                });
            }
            await bus.save();
        }

        res.json({ message: 'Bus seats initialized' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Serve index.html for all non-API routes (SPA fallback)
app.get('*', (req, res) => {
    // Don't serve index.html for API routes
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({ error: 'API endpoint not found' });
    }
    // Serve index.html for all other routes
    res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 5000;

// Only start server if not in Vercel environment
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });
}

// Export app for Vercel serverless functions
module.exports = app;