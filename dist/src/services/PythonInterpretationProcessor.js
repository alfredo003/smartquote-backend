"use strict";
/**
 * Serviço para executar processamento de interpretações em Python
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.pythonProcessor = void 0;
const child_process_1 = require("child_process");
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
class PersistentWorker {
    proc = null;
    busy = false;
    stdoutBuffer = '';
    currentTask = null;
    scriptPath;
    onWorkerFree;
    currentTimeout = null;
    idleTimer = null;
    shouldRespawn = true;
    constructor(scriptPath, onWorkerFree) {
        this.scriptPath = scriptPath;
        this.onWorkerFree = onWorkerFree;
        this.spawn();
    }
    spawn() {
        // Inicia em modo servidor persistente do pipeline de busca e cria cotações automaticamente
        const args = [this.scriptPath, '--server', '--criar-cotacao'];
        this.proc = (0, child_process_1.spawn)('python', args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: process.cwd(),
            env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
            windowsHide: true
        });
        this.proc.stdout?.on('data', (data) => {
            this.stdoutBuffer += data.toString();
            let idx;
            while ((idx = this.stdoutBuffer.indexOf('\n')) >= 0) {
                const line = this.stdoutBuffer.slice(0, idx).trim();
                this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
                if (!line)
                    continue;
                this.handleResultLine(line);
            }
        });
        this.proc.stderr?.on('data', (data) => {
            const s = data.toString();
            console.log(`🐍 [PYTHON-LOG] ${s.trim()}`);
        });
        this.proc.on('error', (err) => {
            console.error(`❌ [PYTHON-WORKER] Erro no processo Python: ${err.message}`);
            this.failCurrent(`Worker error: ${err.message}`);
            this.respawn();
        });
        this.proc.on('close', (code) => {
            console.warn(`⚠️ [PYTHON-WORKER] Processo encerrado (code=${code})`);
            this.failCurrent(`Worker exited (code=${code})`);
            this.respawn();
        });
    }
    respawn() {
        // Limpa estado
        this.proc?.removeAllListeners();
        this.proc = null;
        this.busy = false;
        this.stdoutBuffer = '';
        // Respawn com pequeno atraso
        if (this.shouldRespawn)
            setTimeout(() => this.spawn(), 500);
    }
    handleResultLine(line) {
        // Só tratamos como resultado quando a linha aparenta ser JSON.
        const trimmed = line.trim();
        const first = trimmed[0];
        if (first !== '{' && first !== '[') {
            // Linha não-JSON vinda do stdout (alguma lib pode escrever direto em stdout). Ignorar e continuar aguardando.
            console.log(`🐍 [PYTHON-OUT] ${trimmed}`);
            return;
        }
        // Tentar parsear JSON; somente ao sucesso concluímos a tarefa atual.
        let parsed;
        try {
            parsed = JSON.parse(trimmed);
        }
        catch (err) {
            // Linha parecia JSON mas falhou parse — manter tarefa ativa e aguardar próxima linha ou timeout.
            console.warn(`⚠️ [PYTHON-WORKER] Linha JSON inválida no stdout; aguardando próxima. Detalhe: ${err?.message || err}`);
            return;
        }
        const endTime = Date.now();
        const task = this.currentTask;
        if (!task) {
            // Resultado inesperado sem tarefa corrente — apenas logar.
            console.warn(`⚠️ [PYTHON-WORKER] Resultado recebido sem tarefa ativa: ${trimmed.slice(0, 200)}`);
            return;
        }
        // Fechar estado da tarefa atual
        this.currentTask = null;
        this.busy = false;
        if (this.currentTimeout) {
            clearTimeout(this.currentTimeout);
            this.currentTimeout = null;
        }
        const executionTime = parsed.__t != null ? parsed.__t : (task ? endTime - Number(task.__start) : 0);
        task.resolve({ success: parsed.status === 'success', result: parsed, error: parsed?.error, executionTime });
        // Notifica gerenciador para despachar próxima
        this.onWorkerFree();
    }
    failCurrent(error) {
        if (this.currentTimeout) {
            clearTimeout(this.currentTimeout);
            this.currentTimeout = null;
        }
        const task = this.currentTask;
        this.currentTask = null;
        this.busy = false;
        if (task)
            task.resolve({ success: false, error, executionTime: 0 });
        this.onWorkerFree();
    }
    assign(task, timeoutMs) {
        if (!this.proc || !this.proc.stdin) {
            task.resolve({ success: false, error: 'Worker not ready', executionTime: 0 });
            return;
        }
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        this.busy = true;
        this.currentTask = task;
        task.__start = Date.now();
        // Timeout
        this.currentTimeout = setTimeout(() => {
            console.error(`⏱️ [PYTHON-WORKER] Timeout de ${timeoutMs}ms — matando worker`);
            try {
                this.proc?.kill('SIGKILL');
            }
            catch { }
            this.failCurrent('Task timeout');
        }, timeoutMs);
        // Enviar envelope JSON por linha
        const envelope = JSON.stringify({ rid: task.rid, interpretation: task.interpretation });
        try {
            this.proc.stdin.write(envelope + '\n');
            console.log(`� [PYTHON-WORKER] Tarefa enviada (rid=${task.rid})`);
        }
        catch (err) {
            console.error(`❌ [PYTHON-WORKER] Falha ao escrever no stdin: ${err?.message || err}`);
            this.failCurrent(`stdin write failed: ${err?.message || err}`);
        }
    }
    scheduleScaleDown(ttlMs) {
        if (ttlMs <= 0)
            return;
        if (this.idleTimer)
            clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => {
            if (this.busy)
                return; // já assumiu tarefa
            console.log(`🧹 [PYTHON-WORKER] Encerrando worker ocioso após ${ttlMs}ms`);
            this.shouldRespawn = false; // scale-down: não respawnar automaticamente
            try {
                this.proc?.kill('SIGKILL');
            }
            catch { }
        }, ttlMs);
    }
}
class PythonInterpretationProcessor {
    scriptPath;
    minPool;
    maxPool;
    taskTimeoutMs;
    idleTtlMs;
    queue = [];
    workers = [];
    constructor(options) {
        // Usa caminho relativo ao diretório do projeto para funcionar em dev (ts-node) e build
        this.scriptPath = path_1.default.join(process.cwd(), 'scripts/busca_local/main.py');
        const cpu = Math.max(1, os_1.default.cpus().length || 1);
        const envMin = Number(process.env.PY_POOL_MIN ?? 1);
        const envMax = Number(process.env.PY_POOL_MAX ?? 1); // default 1 para evitar múltiplos processos por padrão
        this.minPool = options?.minPool ?? (isNaN(envMin) ? 1 : Math.max(0, envMin));
        this.maxPool = options?.maxPool ?? (isNaN(envMax) ? this.minPool : Math.max(this.minPool, envMax));
        this.taskTimeoutMs = options?.taskTimeoutMs ?? Number(process.env.PY_TASK_TIMEOUT_MS ?? 120000);
        this.idleTtlMs = options?.idleTtlMs ?? Number(process.env.PY_IDLE_TTL_MS ?? 300000); // 5 min
        console.log(`🐍 [PYTHON-POOL] min=${this.minPool} max=${this.maxPool} timeout=${this.taskTimeoutMs}ms idleTTL=${this.idleTtlMs}ms`);
        // Inicializa apenas o mínimo necessário
        for (let i = 0; i < this.minPool; i++) {
            this.workers.push(new PersistentWorker(this.scriptPath, () => this.onWorkerFree()));
        }
        this.registerExitHandlers();
    }
    /**
     * Enfileira e dispara se houver worker livre
     */
    async processInterpretation(interpretation) {
        return new Promise((resolve, reject) => {
            const rid = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            this.queue.push({ interpretation, resolve, reject, rid });
            console.log(`📥 [PYTHON-POOL] Tarefa enfileirada (rid=${rid}). Fila: ${this.queue.length}`);
            this.pump();
        });
    }
    pump() {
        // Atribui tarefas a workers livres
        for (const worker of this.workers) {
            if (!this.queue.length)
                break;
            if (worker.busy)
                continue;
            const task = this.queue.shift();
            worker.assign(task, this.taskTimeoutMs);
        }
        // Se ainda há fila, escalar até o máximo
        while (this.queue.length > 0 && this.workers.every(w => w.busy) && this.workers.length < this.maxPool) {
            console.log(`⤴️ [PYTHON-POOL] Escalando: criando worker ${this.workers.length + 1}/${this.maxPool}`);
            this.workers.push(new PersistentWorker(this.scriptPath, () => this.onWorkerFree()));
            // Worker novo chamará onWorkerFree quando pronto; mantemos itens na fila
            break; // evita loop apertado; aguardamos callback
        }
    }
    registerExitHandlers() {
        const cleanup = () => {
            for (const w of this.workers) {
                try {
                    w.shouldRespawn = false;
                    w.proc?.kill('SIGKILL');
                }
                catch { }
            }
        };
        process.on('exit', cleanup);
        process.on('SIGINT', () => { cleanup(); process.exit(0); });
        process.on('SIGTERM', () => { cleanup(); process.exit(0); });
    }
    onWorkerFree() {
        // Despacha próximas tarefas
        this.pump();
        // Programa scale-down para ociosos acima do mínimo
        const excess = Math.max(0, this.workers.length - this.minPool);
        if (excess > 0) {
            for (const w of this.workers) {
                if (!w.busy && this.workers.length > this.minPool) {
                    w.scheduleScaleDown(this.idleTtlMs);
                }
            }
        }
    }
    /**
     * Verifica se Python está disponível no sistema
     */
    async checkPythonAvailability() {
        return new Promise((resolve) => {
            const pythonCheck = (0, child_process_1.spawn)('python', ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
            pythonCheck.on('close', (code) => resolve(code === 0));
            pythonCheck.on('error', () => resolve(false));
        });
    }
}
exports.default = PythonInterpretationProcessor;
exports.pythonProcessor = new PythonInterpretationProcessor();
//# sourceMappingURL=PythonInterpretationProcessor.js.map