const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip'); // Nova biblioteca
const cron = require('node-cron');

// ================= CONFIGURAÇÕES =================

// 1. Caminho do arquivo de texto que contém as pastas
const ARQUIVO_PASTAS = path.join(__dirname, 'pastas.txt');
// 2. Pasta onde os backups serão salvos (será criada se não existir)
const ARQUIVO_DESTINO = path.join(__dirname, 'destino.txt'); 
// Pasta de segurança caso o txt esteja vazio
const PASTA_PADRAO = path.join(__dirname, 'meus_backups'); 

// 3. Intervalo de tempo (Formato Cron)
// '0 * * * *' = Roda a cada 1 hora.
// '*/30 * * * * *' = Roda a cada 30 segundos (ótimo para testar).
// '0 0 * * *' = Roda todo dia à meia-noite.
const INTERVALO = '*/30 * * * * *'; 

//Quantos dias os backups devem ser mantidos?
const DIAS_RETENCAO = 4;

// =================================================

function obterPastaDestino() {
    let destino = '';

    // Verifica se o arquivo txt existe e tenta ler a primeira linha
    if (fs.existsSync(ARQUIVO_DESTINO)) {
        const conteudo = fs.readFileSync(ARQUIVO_DESTINO, 'utf-8').split('\n')[0];
        if (conteudo) {
            destino = conteudo.trim();
        }
    }

    // Se o txt não existir ou estiver completamente vazio
    if (!destino) {
        console.log(`[SISTEMA] Arquivo destino.txt vazio ou inexistente. Assumindo rota de segurança: ${PASTA_PADRAO}`);
        destino = PASTA_PADRAO;
        
        // Escreve a rota padrão dentro do txt para orientar o usuário
        fs.writeFileSync(ARQUIVO_DESTINO, PASTA_PADRAO, 'utf-8');
    }

    // Se a pasta escolhida (seja a do txt ou a padrão) não existir no computador, ele cria
    if (!fs.existsSync(destino)) {
        try {
            fs.mkdirSync(destino, { recursive: true });
            console.log(`[SISTEMA] A pasta de destino foi criada no disco: ${destino}`);
        } catch (err) {
            console.error(`[ERRO] Não foi possível criar a pasta de destino ${destino}:`, err.message);
            return null;
        }
    }

    return destino;
}

function limparBackupsAntigos() {
    console.log('\n--- Verificando backups antigos para limpeza ---');
    
    if (!fs.existsSync(PASTA_DESTINO)) return;

    const arquivos = fs.readdirSync(PASTA_DESTINO);
    const tempoAtual = Date.now();
    const tempoLimiteEmMilissegundos = DIAS_RETENCAO * 24 * 60 * 60 * 1000;

    arquivos.forEach(arquivo => {
        // Garante que só vai apagar arquivos .zip para evitar apagar coisas erradas
        if (path.extname(arquivo) !== '.zip') return;

        const caminhoArquivo = path.join(PASTA_DESTINO, arquivo);
        const informacoesArquivo = fs.statSync(caminhoArquivo);
        
        // Calcula a idade do arquivo com base na data de modificação
        const idadeDoArquivo = tempoAtual - informacoesArquivo.mtimeMs;

        if (idadeDoArquivo > tempoLimiteEmMilissegundos) {
            try {
                fs.unlinkSync(caminhoArquivo); // Apaga o arquivo
                console.log(`[LIXEIRA] Backup antigo removido: ${arquivo}`);
            } catch (err) {
                console.error(`[ERRO] Não foi possível apagar ${arquivo}:`, err.message);
            }
        }
    });
}

function fazerBackup() {
    console.log('\n--- Iniciando rotina de backup ---');

    if (!fs.existsSync(ARQUIVO_PASTAS)) {
        console.error(`Arquivo de texto não encontrado: ${ARQUIVO_PASTAS}`);
        return;
    }

    const caminhos = fs.readFileSync(ARQUIVO_PASTAS, 'utf-8')
        .split('\n')
        .map(linha => linha.trim())
        .filter(linha => linha.length > 0);

    if (caminhos.length === 0) {
        console.log('Nenhuma pasta encontrada no arquivo.txt');
        return;
    }

    const dataAtual = new Date();
    const dataFormatada = dataAtual.toISOString().replace(/T/, '_').replace(/:/g, '-').split('.')[0];

    caminhos.forEach(pastaOrigem => {
        if (!fs.existsSync(pastaOrigem)) {
            console.error(`[ERRO] A pasta não existe: ${pastaOrigem}`);
            return;
        }

        const nomePasta = path.basename(pastaOrigem);
        const nomeArquivoZip = `Backup_${nomePasta}_${dataFormatada}.zip`;
        const caminhoDestinoZip = path.join(PASTA_DESTINO, nomeArquivoZip);

        try {
            console.log(`Compactando ${nomePasta}...`);
            
            // Inicia o processo de ZIP com a nova biblioteca
            const zip = new AdmZip();
            
            // Adiciona todo o conteúdo da pasta original no arquivo
            zip.addLocalFolder(pastaOrigem);
            
            // Salva fisicamente no disco
            zip.writeZip(caminhoDestinoZip);
            
            console.log(`[SUCESSO] Salvo: ${nomeArquivoZip}`);
        } catch (err) {
            console.error(`[ERRO] Falha ao compactar ${nomePasta}:`, err.message);
        }
    });
}

// Inicia o agendador
console.log(`Serviço de backup iniciado. Aguardando o intervalo programado (${INTERVALO})...`);

cron.schedule(INTERVALO, () => {
    fazerBackup();
});

// Descomente a linha abaixo se quiser que ele faça o backup logo que você iniciar o programa, 
// além de esperar o tempo agendado:
// fazerBackup();