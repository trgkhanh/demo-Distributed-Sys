import express, { Request, Response } from 'express';
import axios from 'axios';

const app = express();
app.use(express.json());

const GATEWAY_PORT = 3000;

// Sử dụng trực tiếp 127.0.0.1 để tránh lỗi phân giải IPv6 trên Windows
const TARGET_SERVERS = [
    'http://localhost:3001', // Node_A (Primary)
    'http://localhost:3003'  // Node_A_rep (Replica)
];

async function forwardRequest(req: Request, res: Response): Promise<void> {
    console.log(`\n[GATEWAY] Nhận yêu cầu: \(${req.method}\)${req.originalUrl}`);

    // Chỉ chuyển tiếp req.body nếu là các phương thức ghi dữ liệu
    const hasBody = ['POST', 'PUT', 'PATCH'].includes(req.method);

    for (const targetUrl of TARGET_SERVERS) {
        try {
            const url = `${targetUrl}${req.originalUrl}`;
            console.log(`-> Thử chuyển tiếp tới: ${url}`);

            const response = await axios({
                method: req.method,
                url: url,
                data: hasBody ? req.body : undefined,
                timeout: 2500
            });

            console.log(`-> Thành công từ \(${targetUrl} (Status:\)${response.status})`);
            res.status(response.status).json(response.data);
            return;
        } catch (error: any) {
            if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
                console.warn(`-> [MẤT KẾT NỐI] ${targetUrl} không phản hồi, thử node tiếp theo...`);
                continue;
            }

            // Trường hợp node đích có phản hồi nhưng trả lỗi logic (400, 404, 500)
            if (error.response) {
                console.log(`-> Node trả lỗi nghiệp vụ: ${error.response.status}`);
                res.status(error.response.status).json(error.response.data);
                return;
            }

            console.error(`-> Lỗi không xác định: ${error.message}`);
        }
    }

    console.error(`-> [THẤT BẠI] Toàn bộ cụm server đều không phản hồi.`);
    res.status(503).json({
        error: 'Toàn bộ cụm server (Node_A và Node_A_rep) đều không thể kết nối. Hãy kiểm tra xem 2 node này đã được bật chưa.'
    });
}

// Chặn các endpoint không phải API công khai
app.use((req: Request, res: Response) => {
    if (!req.originalUrl.startsWith('/api')) {
        res.status(403).json({ error: 'Gateway chỉ tiếp nhận các đường dẫn bắt đầu bằng /api' });
        return;
    }
    forwardRequest(req, res);
});

app.listen(GATEWAY_PORT, '0.0.0.0', () => {
    console.log(`=======================================================`);
    console.log(`[API GATEWAY] Sẵn sàng tại http://localhost:${GATEWAY_PORT}`);
    console.log(`[TARGETS] Cụm đích: ${TARGET_SERVERS.join(' -> ')}`);
    console.log(`=======================================================`);
});