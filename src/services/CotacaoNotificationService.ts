import { NotificationService } from './NotificationService';
import { Notification } from '../models/Notification';
import { CotacaoDTO } from '../models/Cotacao';

export class CotacaoNotificationService {
  private notificationService = new NotificationService();

  /**
   * Cria notificação quando uma nova cotação é criada
   */
  async notificarCotacaoCriada(cotacao: CotacaoDTO): Promise<void> {
    const notification: Notification = {
      title: 'Nova Cotação Criada',
      subject: `Nova cotação criada para ${cotacao.produto?.nome || 'Produto'} (ID: ${cotacao.id})`,
      type: 'cotacao_criada',
      url_redir: `/cotacoes/${cotacao.id}`
    };

    try {
      await this.notificationService.createIfNotExists(notification);
      console.log(`📋 [COTACAO-NOTIF] Notificação criada para nova cotação ID: ${cotacao.id}`);
    } catch (error) {
      console.error(`📋 [COTACAO-NOTIF] Erro ao criar notificação para cotação ${cotacao.id}:`, error);
    }
  }

  /**
   * Cria notificação quando uma cotação é aprovada
   */
  async notificarCotacaoAprovada(cotacao: CotacaoDTO): Promise<void> {
    const notification: Notification = {
      title: 'Cotação Aprovada',
      subject: `Cotação aprovada para ${cotacao.produto?.nome || 'Produto'} (ID: ${cotacao.id}) - Motivo: ${cotacao.motivo}`,
      type: 'cotacao_aprovada',
      url_redir: `/cotacoes/${cotacao.id}`
    };

    try {
      await this.notificationService.createIfNotExists(notification);
      console.log(`✅ [COTACAO-NOTIF] Notificação criada para cotação aprovada ID: ${cotacao.id}`);
    } catch (error) {
      console.error(`📋 [COTACAO-NOTIF] Erro ao criar notificação de aprovação para cotação ${cotacao.id}:`, error);
    }
  }

  /**
   * Cria notificação quando uma cotação é rejeitada
   */
  async notificarCotacaoRejeitada(cotacao: CotacaoDTO): Promise<void> {
    const notification: Notification = {
      title: 'Cotação Rejeitada',
      subject: `Cotação rejeitada para ${cotacao.produto?.nome || 'Produto'} (ID: ${cotacao.id}) - Motivo: ${cotacao.motivo}`,
      type: 'cotacao_rejeitada',
      url_redir: `/cotacoes/${cotacao.id}`
    };

    try {
      await this.notificationService.createIfNotExists(notification);
      console.log(`❌ [COTACAO-NOTIF] Notificação criada para cotação rejeitada ID: ${cotacao.id}`);
    } catch (error) {
      console.error(`📋 [COTACAO-NOTIF] Erro ao criar notificação de rejeição para cotação ${cotacao.id}:`, error);
    }
  }

  /**
   * Cria notificação quando uma cotação é deletada
   */
  async notificarCotacaoDeletada(cotacao: CotacaoDTO): Promise<void> {
    const notification: Notification = {
      title: 'Cotação Deletada',
      subject: `Cotação deletada para ${cotacao.produto?.nome || 'Produto'} (ID: ${cotacao.id})`,
      type: 'cotacao_deletada',
      url_redir: `/cotacoes`
    };

    try {
      await this.notificationService.createIfNotExists(notification);
      console.log(`🗑️ [COTACAO-NOTIF] Notificação criada para cotação deletada ID: ${cotacao.id}`);
    } catch (error) {
      console.error(`📋 [COTACAO-NOTIF] Erro ao criar notificação de deleção para cotação ${cotacao.id}:`, error);
    }
  }

  /**
   * Processa notificação baseada no status da cotação
   */
  async processarNotificacaoCotacao(cotacao: CotacaoDTO, acao: 'criada' | 'aprovada' | 'rejeitada' | 'deletada'): Promise<void> {
    switch (acao) {
      case 'criada':
        await this.notificarCotacaoCriada(cotacao);
        break;
      case 'aprovada':
        await this.notificarCotacaoAprovada(cotacao);
        break;
      case 'rejeitada':
        await this.notificarCotacaoRejeitada(cotacao);
        break;
      case 'deletada':
        await this.notificarCotacaoDeletada(cotacao);
        break;
      default:
        console.warn(`📋 [COTACAO-NOTIF] Ação desconhecida: ${acao}`);
    }
  }

  /**
   * Analisa mudanças na cotação e determina que tipo de notificação enviar
   */
  async analisarENotificarMudancas(cotacaoAntiga: CotacaoDTO | null, cotacaoNova: CotacaoDTO): Promise<void> {
    // Se não há cotação anterior, é uma criação
    if (!cotacaoAntiga) {
      await this.processarNotificacaoCotacao(cotacaoNova, 'criada');
      return;
    }

    // Verificar se houve mudança no status de aprovação
    if (cotacaoAntiga.aprovacao !== cotacaoNova.aprovacao) {
      if (cotacaoNova.aprovacao) {
        await this.processarNotificacaoCotacao(cotacaoNova, 'aprovada');
      } else {
        await this.processarNotificacaoCotacao(cotacaoNova, 'rejeitada');
      }
    }

    // Verificar se houve mudança no status (se disponível)
    if (cotacaoAntiga.status !== cotacaoNova.status) {
      switch (cotacaoNova.status) {
        case 'aceite':
          await this.processarNotificacaoCotacao(cotacaoNova, 'aprovada');
          break;
        case 'recusado':
          await this.processarNotificacaoCotacao(cotacaoNova, 'rejeitada');
          break;
      }
    }
  }

  /**
   * Remove notificações relacionadas a uma cotação específica
   */
  async removerNotificacoesCotacao(cotacaoId: number): Promise<void> {
    try {
      const todasNotificacoes = await this.notificationService.getAll();
      const notificacoesCotacao = todasNotificacoes.filter(notif => 
        notif.type.startsWith('cotacao_') && 
        (notif.subject.includes(`(ID: ${cotacaoId})`) || notif.url_redir?.includes(`/cotacoes/${cotacaoId}`))
      );

      for (const notificacao of notificacoesCotacao) {
        await this.notificationService.delete(notificacao.id);
        console.log(`🧹 [COTACAO-NOTIF] Notificação removida: ${notificacao.subject}`);
      }
    } catch (error) {
      console.error(`📋 [COTACAO-NOTIF] Erro ao remover notificações da cotação ${cotacaoId}:`, error);
    }
  }
}

export default new CotacaoNotificationService();
