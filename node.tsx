import express, { Request, Response } from 'express';
import axios from 'axios';
import dotenv from 'dotenv';

// Tự động nạp file cấu hình truyền từ tham số dòng lệnh (mặc định là .env)
const envFile = process.argv[2] || '.env';
dotenv.config({ path: envFile });

const app = express();
app.use(express.json());

// ---------------------------------------------------------
// 1. CẤU HÌNH BIẾN MÔI TRƯỜNG & KHỞI TẠO TRẠNG THÁI
// ---------------------------------------------------------
const PORT = Number(process.env.PORT) || 3001;
const NODE_NAME = process.env.NODE_NAME || 'Node';
const INITIAL_ROLE = (process.env.ROLE as 'PRIMARY' | 'REPLICA') || 'PRIMARY';

// Cấu hình Sharding (ID chẵn/lẻ)
const SHARD_MOD = Number(process.env.SHARD_MOD) || 2;
const SHARD_REMAINDER = Number(process.env.SHARD_REMAINDER) || 0;

// Kết nối giữa Primary và Replica trên cùng một máy (Localhost)
const LOCAL_PARTNER_URL = process.env.LOCAL_PARTNER_URL || '';

// Kết nối sang máy đối tác qua Ngrok
const PEER_URL = process.env.PEER_URL || '';

// Instance Axios gửi qua ngrok (vượt màn hình cảnh báo của ngrok)
const axiosNgrok = axios.create({
    headers: { 'ngrok-skip-browser-warning': 'true' },
    timeout: 1500
});

type Employee = { id: number; name: string; salary: number }; 

// Dữ liệu mẫu ban đầu theo phân mảnh
let localData: Employee[] = SHARD_REMAINDER === 0
    ? [{ id: 2, name: 'Bob', salary: 2000 }]
    : [{ id: 3, name: 'Charlie', salary: 1800 }]; 

// Cờ trạng thái: Primary khi mới bật sẽ là RECOVERING để kéo bù dữ liệu trước
let currentRole: 'PRIMARY' | 'REPLICA' | 'RECOVERING' =
    INITIAL_ROLE === 'PRIMARY' ? 'RECOVERING' : 'REPLICA';

// Cờ kiểm tra kết nối máy đối tác (Circuit Breaker)
let isPeerOnline = false;

function isMyShard(id: number): boolean {
    return Math.abs(id) % SHARD_MOD === SHARD_REMAINDER;
}

function calculateLocalTotal(): number {
    return localData.reduce((sum, emp) => sum + emp.salary, 0); 
}

// ---------------------------------------------------------
// 2. TIẾN TRÌNH HEARTBEAT NGẦM (GIÁM SÁT KẾT NỐI MÁY ĐỐI TÁC)
// ---------------------------------------------------------
if (PEER_URL && PEER_URL.trim() !== '') {
    setInterval(async () => {
        try {
            // Ping với timeout ngắn (800ms) để không gây nghẽn luồng
            await axiosNgrok.get(`${PEER_URL}/internal/health`, { timeout: 800 });
            if (!isPeerOnline) {
                isPeerOnline = true;
                console.log(`\n[PEER] Đã kết nối thông suốt tới máy đối tác (${PEER_URL})!`);
            }
        } catch (error) {
            if (isPeerOnline) {
                isPeerOnline = false;
                console.warn(`\n[PEER] Mất kết nối tới máy đối tác.`);
            }
        }
    }, 3000);
}

// ---------------------------------------------------------
// 3. API DÀNH CHO CLIENT
// ---------------------------------------------------------


// Thêm nhân viên: Sharding + Replication nội bộ + Định tuyến Ngrok
app.post('/api/employee', async (req: Request, res: Response): Promise<void> => {
    if (currentRole === 'RECOVERING') {
        res.status(503).json({ error: 'Node đang phục hồi dữ liệu từ Replica, vui lòng đợi.' });
        return;
    }

    if (currentRole === 'REPLICA') {
        res.status(403).json({
            error: 'Node này đang là REPLICA (Read-Only). Vui lòng gửi tới Primary.',
            primary_url: LOCAL_PARTNER_URL
        });
        return;
    }

    const emp: Employee = req.body;
    if (!emp || typeof emp.id !== 'number') {
        res.status(400).json({ error: 'Dữ liệu không hợp lệ, thiếu id' });
        return;
    }

    // A. Nếu thuộc phân mảnh của máy này
    if (isMyShard(emp.id)) {
        localData.push(emp);
        console.log(`\n[PRIMARY] Đã lưu ID \({emp.id} (\){emp.name}) vào RAM.`);

        // Sao lưu tức thì sang Replica trên cùng máy
        if (LOCAL_PARTNER_URL) {
            try {
                await axios.post(`${LOCAL_PARTNER_URL}/internal/replicate`, emp, { timeout: 1500 });
                console.log(`-> [REPLICATION] Đã sao lưu sang Replica (${LOCAL_PARTNER_URL}).`);
            } catch (err) {
                console.warn(`-> [CẢNH BÁO] Không thể sao lưu sang Replica cục bộ.`);
            }
        }

        res.json({ message: 'Lưu thành công', stored_at: NODE_NAME });
        return;
    }

    // B. Nếu thuộc phân mảnh của máy đối tác
    console.log(`\n[ĐỊNH TUYẾN] ID ${emp.id} thuộc máy đối tác...`);
    if (!PEER_URL || !isPeerOnline) {
        res.status(503).json({
            error: 'Máy đối tác đang tắt hoặc chưa kết nối, không thể định tuyến bản ghi này!'
        });
        return;
    }

    try {
        await axiosNgrok.post(`${PEER_URL}/internal/employee`, emp);
        console.log(`-> [THÀNH CÔNG] Đã định tuyến dữ liệu sang máy đối tác.`);
        res.json({ message: 'Đã định tuyến thành công sang máy đối tác qua ngrok' });
    } catch (error) {
        isPeerOnline = false;
        res.status(503).json({ error: 'Lỗi đường truyền khi gửi sang máy đối tác' });
    }
});

// 1. Xem dữ liệu máy hiện tại
app.get('/api/data', (req: Request, res: Response) => {
    res.json({
        node: NODE_NAME,
        role: currentRole,
        total_employees: localData.length,
        data: localData
    });
});

// 2. Lấy toàn bộ nhân viên (Hỗ trợ cả /api/employees và /api/employees/all)
const handleGetAllEmployees = async (req: Request, res: Response): Promise<void> => {
    const employeesByNode: Record<string, Employee[]> = { [NODE_NAME]: localData };

    if (PEER_URL && isPeerOnline) {
        try {
            const response = await axiosNgrok.get(`${PEER_URL}/internal/employees`, { timeout: 1000 });
            employeesByNode[response.data.node] = response.data.data;
        } catch (error) {
            isPeerOnline = false;
        }
    }

    const all = Object.values(employeesByNode).flat();
    res.json({
        total_employees: all.length,
        nodes: employeesByNode,
        data: all
    });
};

app.get('/api/employees', handleGetAllEmployees);

// 3. Tìm nhân viên theo ID (Khắc phục lỗi tra cứu khi Node B tắt)
app.get('/api/employees/:id', async (req: Request, res: Response): Promise<void> => {
    const employeeId = Number(req.params.id);
    if (!Number.isInteger(employeeId)) {
        res.status(400).json({ error: 'ID nhân viên phải là số nguyên' });
        return;
    }

    // Luôn ưu tiên quét trong RAM của máy này trước
    const localEmp = localData.find((item) => item.id === employeeId);
    if (localEmp) {
        res.json({ node: NODE_NAME, data: localEmp });
        return;
    }

    // Nếu không có ở máy này và thuộc phân mảnh của mình -> Báo 404
    if (isMyShard(employeeId)) {
        res.status(404).json({ error: `Không tìm thấy nhân viên ID \({employeeId} trên\){NODE_NAME}` });
        return;
    }

    // Nếu thuộc phân mảnh máy đối tác mà đối tác chưa bật -> Thông báo rõ ràng
    if (!PEER_URL || !isPeerOnline) {
        res.status(503).json({
            error: `ID ${employeeId} thuộc phân mảnh máy đối tác, nhưng máy đối tác hiện chưa kết nối.`
        });
        return;
    }

    // Gọi sang đối tác qua ngrok nếu đối tác online
    try {
        const response = await axiosNgrok.get(`\({PEER_URL}/internal/employees/\){employeeId}`, { timeout: 1000 });
        res.json(response.data);
    } catch (error) {
        res.status(404).json({ error: `Không tìm thấy nhân viên ID ${employeeId}` });
    }
});


// Tính tổng quỹ lương phân tán (MapReduce tức thì)
app.get('/api/salary/total', async (req: Request, res: Response) => {
    const myTotal = calculateLocalTotal();
    let peerTotal = 0;
    let peerNode = 'Máy đối tác (Chưa kết nối)';

    // Chỉ gọi sang đối tác nếu có tín hiệu trực tuyến
    if (PEER_URL && isPeerOnline) {
        try {
            const resp = await axiosNgrok.get(`${PEER_URL}/internal/salary`, { timeout: 1000 });
            peerTotal = resp.data.localTotal;
            peerNode = resp.data.node;
        } catch (err) {
            isPeerOnline = false;
        }
    }

    // Trả kết quả ngay lập tức mà không phải chờ timeout
    res.json({
        coordinator: NODE_NAME, 
        breakdown: {
            [NODE_NAME]: myTotal,
            [peerNode]: peerTotal
        },
        final_total: myTotal + peerTotal 
    });
});

// ---------------------------------------------------------
// 4. API NỘI BỘ (RPC, SAO LƯU, PHỤC HỒI)
// ---------------------------------------------------------

// Endpoint kiểm tra sức khỏe
app.get('/internal/health', (req: Request, res: Response) => {
    res.json({ status: 'OK', node: NODE_NAME, role: currentRole });
});

// Tiếp nhận bản ghi sao lưu từ Primary (Replica xử lý)
app.post('/internal/replicate', (req: Request, res: Response) => {
    localData.push(req.body);
    console.log(`[REPLICA] Nhận bản sao chép: ID \({req.body.id} (\){req.body.name})`);
    res.json({ status: 'replicated' });
});

// Xuất toàn bộ dữ liệu để Primary nạp bù khi sống lại (Failback)
app.get('/internal/dump-data', (req: Request, res: Response) => {
    console.log(`[FAILBACK] Máy chính yêu cầu xuất dữ liệu để phục hồi.`);
    res.json({ data: localData });
});

// Lệnh hạ cấp từ Primary
app.post('/internal/demote', (req: Request, res: Response) => {
    currentRole = 'REPLICA';
    console.log(`[HẠ CẤP] Đã hạ cấp về REPLICA theo lệnh của Primary.`);
    res.json({ status: 'demoted' });
});

// Nhận dữ liệu định tuyến từ máy khác gửi sang
app.post('/internal/employee', async (req: Request, res: Response): Promise<void> => {
    const emp: Employee = req.body;
    localData.push(emp); 
    console.log(`[NỘI BỘ] Đã nhận và lưu ID \({emp.id} (\){emp.name}) từ máy đối tác.`);

    // Nếu đang là Primary, tiếp tục sao lưu sang replica nội bộ
    if (currentRole === 'PRIMARY' && LOCAL_PARTNER_URL) {
        try {
            await axios.post(`${LOCAL_PARTNER_URL}/internal/replicate`, emp, { timeout: 1500 });
        } catch (e) {}
    }

    res.json({ status: 'success', node: NODE_NAME }); 
});

app.get('/internal/employees', (req: Request, res: Response) => {
    res.json({ node: NODE_NAME, total_employees: localData.length, data: localData }); 
});

app.get('/internal/employees/:id', (req: Request, res: Response) => {
    const id = Number(req.params.id); 
    const emp = localData.find((item) => item.id === id); 
    if (!emp) {
        res.status(404).json({ error: `Không tìm thấy nhân viên ID ${id}` }); 
        return;
    }
    res.json({ node: NODE_NAME, data: emp }); 
});

app.get('/internal/salary', (req: Request, res: Response) => {
    res.json({ node: NODE_NAME, localTotal: calculateLocalTotal() }); 
});

// ---------------------------------------------------------
// 5. CƠ CHẾ TỰ ĐỘNG FAILOVER (REPLICA) VÀ FAILBACK (PRIMARY)
// ---------------------------------------------------------

// A. Tiến trình Replica giám sát Primary cục bộ (Failover)
let failedPings = 0;
if (INITIAL_ROLE === 'REPLICA') {
    setInterval(async () => {
        if (currentRole === 'PRIMARY') return;

        try {
            await axios.get(`${LOCAL_PARTNER_URL}/internal/health`, { timeout: 1500 });
            failedPings = 0;
        } catch (err) {
            failedPings++;
            console.warn(`[FAILOVER MONITOR] Mất kết nối tới Primary (Lần ${failedPings}/2)...`);

            if (failedPings >= 2) {
                currentRole = 'PRIMARY';
                console.error(`=======================================================`);
                console.error(`[FAILOVER] Primary sập! ${NODE_NAME} chính thức thăng cấp làm PRIMARY!`);
                console.error(`=======================================================`);
            }
        }
    }, 2000);
}

// B. Tiến trình Primary phục hồi dữ liệu từ Replica khi khởi động lại (Failback)
async function performFailback() {
    if (INITIAL_ROLE !== 'PRIMARY') return;

    try {
        console.log(`[FAILBACK] Đang kết nối tới ${LOCAL_PARTNER_URL} để nạp bù dữ liệu...`);
        const response = await axios.get(`${LOCAL_PARTNER_URL}/internal/dump-data`, { timeout: 2500 });

        localData = response.data.data;
        console.log(`[FAILBACK] Đã cập nhật ${localData.length} bản ghi mới nhất từ Replica.`);

        // Gửi lệnh hạ cấp Replica về lại chế độ dự phòng
        await axios.post(`${LOCAL_PARTNER_URL}/internal/demote`, {}, { timeout: 2000 });
        console.log(`[FAILBACK] Đã hạ cấp Replica về trạng thái BACKUP.`);

        currentRole = 'PRIMARY';
        console.log(`[SYSTEM] ${NODE_NAME} chính thức tiếp quản lại vai trò PRIMARY.`);
    } catch (error) {
        console.log(`[STARTUP] Replica chưa chạy hoặc chạy lần đầu. Khởi tạo vai trò PRIMARY.`);
        currentRole = 'PRIMARY';
    }
}

// ---------------------------------------------------------
// 6. KHỞI CHẠY SERVER
// ---------------------------------------------------------
app.listen(PORT, '0.0.0.0', async () => { 
    console.log(`=======================================================`);
    console.log(`[SERVER] \({NODE_NAME} đang chạy trên cổng\){PORT}`); 
    console.log(`[ROLE] Khởi tạo: \({INITIAL_ROLE} | Quản lý: ID %\){SHARD_MOD} === ${SHARD_REMAINDER}`);
    console.log(`[CONFIG] Partner cục bộ: ${LOCAL_PARTNER_URL || 'None'}`);
    console.log(`[CONFIG] Peer Ngrok: ${PEER_URL || 'None'}`);
    console.log(`=======================================================`);

    if (INITIAL_ROLE === 'PRIMARY') {
        await performFailback();
    }
});